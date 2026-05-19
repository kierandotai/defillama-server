import type { PlatformAdapter, FundingEntry, ParsedPerpsMarket } from "../types";
import { safeFetch } from "../types";
import { fetchPythPricesBySymbol, applyOstiumFallbackPrices } from "./pyth";

// GMTrade — Solana (gmsol-labs port of GMX V2).
// Docs: https://docs.gmtrade.xyz/
// RWA assets: 23 markets (10 stocks/ETFs, 7 forex, 6 metals/oil).
// Margin: USDC (RWA pools are all [USDC-USDC]) | Oracle: Chainlink Data Streams
// Max leverage: 500× during trading hours, capped overnight.

// Subsquid indexer — single source for market metadata, volume, OI.
// Fields named *TokenAmount* on `MarketStateUpdated` pools are USD-scaled by
// USD_DECIMALS (20 on this fork), not raw token amounts; the bundle's
// `getMarketOpenInterestUsd` sums them directly without scaling. Each event
// only carries pool kinds that the underlying instruction actually wrote, so
// `OpenInterestForLong` and `OpenInterestForShort` never co-emit — we have to
// query the latest event for each kind separately.
const GMTRADE_SQUID = "https://gmx-solana-sqd.squids.live/gmx-solana-base:prod/api/graphql";

// Price-candle GraphQL (separate service) — used for the 24h price change.
const GMTRADE_PRICE_CANDLE = "https://price-candle-mainnet.gmtrade.xyz/graphql";

// gmsol uses USD_DECIMALS = 20 (vs 30 on EVM GMX V2). The SPA bundle has
//   const GMX_USD_DECIMALS = 30; const USD_DECIMALS = 20;
// and an adjustPrice helper that divides EVM-side prices by 1e10.
const USD_SCALE = BigInt(10) ** BigInt(20);
const FOUR_DEC = BigInt(10000);

// Index symbols that count as RWA on GMTrade.
const RWA_INDEX_SYMBOLS = new Set([
  // Stocks & ETFs
  "AAPL", "AMZN", "GOOGL", "META", "MSFT", "MSTR", "NVDA", "QQQ", "SPY", "TSLA",
  // Forex (note: USD/CAD etc. have USD as the base, handled in parser)
  "AUD", "EUR", "GBP", "NZD",
  // Precious metals + industrial + oil
  "XAU", "XAG", "XCU", "XPD", "XPT", "WTI",
]);

// Symbols whose "base" is USD (i.e. USD/CAD, USD/CHF, USD/JPY) — for these we
// flip the contract id so the quote currency is the named symbol.
const USD_BASE_FX_QUOTES = new Set(["CAD", "CHF", "JPY"]);

// GMTrade symbol → Pyth lookup alias (only where Pyth uses a different base).
const PYTH_SYMBOL_ALIASES: Record<string, string> = {
  WTI: "XTI",     // Pyth Metal.XTI/USD for crude oil
};

// GMTrade symbol → Ostium price-feed key. Ostium's live-price API uses
// "FROM+TO" without a separator (e.g. "USDCAD" for the USD/CAD pair,
// "CLUSD" for WTI crude, "HGUSD" for copper). Pyth lacks USD-base FX and
// some metals, so we fall back to Ostium for those.
const OSTIUM_KEY_ALIASES: Record<string, string> = {
  WTI: "CLUSD",
  XCU: "HGUSD",
  USDCAD: "USDCAD",
  USDCHF: "USDCHF",
  USDJPY: "USDJPY",
};

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

interface MarketInfo {
  id: string;              // marketToken pubkey
  name: string;            // e.g. "NVDA/USD[USDC-USDC]"
  longTokenMint: string;
  shortTokenMint: string;
  indexTokenMint: string;
  decimal: number;
}

interface MarketStatsRow {
  marketToken: string;
  volume24h: string;
  totalVolume: string;
  totalFees: string;
  timestamp: string;
}

interface MarketStateUpdate {
  marketToken: string;
  timestamp: string;
  poolKinds: string;  // JSON-string of [{kind:"Primary"},{kind:"OpenInterestForLong"},...]
  pools: string;      // JSON-string of [{longTokenAmount,shortTokenAmount,isPure,...}, ...]
}

interface PoolEntry {
  longTokenAmount: string;
  shortTokenAmount: string;
  isPure: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigIntToUsd(s: string | null | undefined): number {
  if (!s) return 0;
  try {
    // 4-decimal precision is enough for the preview / pipeline.
    return Number((BigInt(s) * FOUR_DEC) / USD_SCALE) / 10000;
  } catch {
    return 0;
  }
}

/**
 * Parse a GMTrade market name into a canonical (indexSymbol, pythSymbol, contractSuffix).
 * Examples:
 *   "NVDA/USD[USDC-USDC]" → { indexSymbol: "NVDA",     pyth: "NVDA",     suffix: "NVDA-USD" }
 *   "EUR/USD[USDC-USDC]"  → { indexSymbol: "EUR",      pyth: "EUR",      suffix: "EUR-USD"  }
 *   "USD/CAD[USDC-USDC]"  → { indexSymbol: "USDCAD",   pyth: "USDCAD",   suffix: "USDCAD-USD" }
 *   "WTI/USD[USDC-USDC]"  → { indexSymbol: "WTI",      pyth: "XTI",      suffix: "WTI-USD"  }
 */
function parseMarketName(name: string): {
  indexSymbol: string;
  pythSymbol: string;
  contractSuffix: string;
} | null {
  const bracketIdx = name.indexOf("[");
  const head = bracketIdx >= 0 ? name.slice(0, bracketIdx) : name;
  const [base, quote] = head.split("/");
  if (!base || !quote) return null;

  // USD/CAD style: collapse to "USDCAD" / "USD"
  let indexSymbol: string;
  let canonicalQuote: string;
  if (base === "USD" && USD_BASE_FX_QUOTES.has(quote)) {
    indexSymbol = `USD${quote}`;
    canonicalQuote = "USD";
  } else {
    indexSymbol = base;
    canonicalQuote = quote;
  }

  const pythSymbol = PYTH_SYMBOL_ALIASES[indexSymbol] ?? indexSymbol;
  return {
    indexSymbol,
    pythSymbol,
    contractSuffix: `${indexSymbol}-${canonicalQuote}`,
  };
}

function isRwaSymbol(indexSymbol: string): boolean {
  // The set holds the base of non-USD-base FX pairs ("AUD", "EUR"…) AND the
  // collapsed USDCAD/USDCHF/USDJPY forms via the USD_BASE_FX_QUOTES check.
  if (RWA_INDEX_SYMBOLS.has(indexSymbol)) return true;
  // Catch the USD-base FX (USDCAD, USDCHF, USDJPY) that aren't in the set above.
  if (indexSymbol.startsWith("USD") && indexSymbol.length === 6) {
    return USD_BASE_FX_QUOTES.has(indexSymbol.slice(3));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchMarketInfos(): Promise<MarketInfo[]> {
  const json = await safeFetch<{ data?: { marketInfos?: MarketInfo[] } }>(
    GMTRADE_SQUID,
    "GMTrade squid marketInfos",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          marketInfos(limit: 200) {
            id name longTokenMint shortTokenMint indexTokenMint decimal
          }
        }`,
      }),
    },
  );
  return json?.data?.marketInfos ?? [];
}

async function fetchLatestVolumePerMarket(): Promise<Map<string, MarketStatsRow>> {
  const json = await safeFetch<{ data?: { marketTotalStatsHourlies?: MarketStatsRow[] } }>(
    GMTRADE_SQUID,
    "GMTrade squid marketTotalStatsHourlies",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          marketTotalStatsHourlies(orderBy: timestamp_DESC, limit: 200) {
            marketToken volume24h totalVolume totalFees timestamp
          }
        }`,
      }),
    },
  );
  const rows = json?.data?.marketTotalStatsHourlies ?? [];
  // Squid returns the most recent rows across all markets — keep latest per token.
  const latest = new Map<string, MarketStatsRow>();
  for (const r of rows) {
    const prev = latest.get(r.marketToken);
    if (!prev || r.timestamp > prev.timestamp) latest.set(r.marketToken, r);
  }
  return latest;
}

/**
 * Fetch the latest USD-1e20 value for a single OI pool kind on one market.
 *
 * Returns the raw BigInt (long-token + short-token amounts summed) — caller
 * scales to USD. Used twice per market: once for `OpenInterestForLong`,
 * once for `OpenInterestForShort`. Cross-checked against the live UI for
 * WTI/USD: $2.9M long + $2.5M short = $5.4M total, matching the bar at
 * gmtrade.xyz/trade.
 */
async function fetchPoolRaw(marketToken: string, poolKind: "OpenInterestForLong" | "OpenInterestForShort"): Promise<bigint> {
  const body = JSON.stringify({
    query: `{
      marketStateUpdateds(
        where: { marketToken_eq: ${JSON.stringify(marketToken)}, poolKinds_contains: ${JSON.stringify(poolKind)} },
        orderBy: timestamp_DESC,
        limit: 1
      ) { poolKinds pools }
    }`,
  });
  // One retry covers the occasional 502 we see on the squid endpoint.
  let json: { data?: { marketStateUpdateds?: MarketStateUpdate[] } } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    json = await safeFetch<{ data?: { marketStateUpdateds?: MarketStateUpdate[] } }>(
      GMTRADE_SQUID,
      `GMTrade ${poolKind} for ${marketToken.slice(0, 6)}…${attempt > 0 ? " (retry)" : ""}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
    );
    if (json?.data?.marketStateUpdateds) break;
  }
  const ev = json?.data?.marketStateUpdateds?.[0];
  if (!ev) return BigInt(0);

  let kinds: Array<{ kind: string }>;
  let pools: PoolEntry[];
  try {
    kinds = JSON.parse(ev.poolKinds);
    pools = JSON.parse(ev.pools);
  } catch {
    return BigInt(0);
  }

  const idx = kinds.findIndex((k) => k.kind === poolKind);
  if (idx < 0 || !pools[idx]) return BigInt(0);
  return (
    BigInt(pools[idx].longTokenAmount || "0") +
    BigInt(pools[idx].shortTokenAmount || "0")
  );
}

async function fetchMarketOiRaw(marketToken: string): Promise<{ long: bigint; short: bigint }> {
  const [long, short] = await Promise.all([
    fetchPoolRaw(marketToken, "OpenInterestForLong"),
    fetchPoolRaw(marketToken, "OpenInterestForShort"),
  ]);
  return { long, short };
}

function rawToUsd(raw: bigint): number {
  return Number((raw * FOUR_DEC) / USD_SCALE) / 10000;
}

/**
 * Fetch the latest per-second funding factor for one market (from `fundingRateHourlies`).
 * Returns the raw signed value (per-second rate, scaled by USD_DECIMALS = 1e20).
 *
 * Sign convention in gmsol (verified empirically + via the bundle's
 * `selectFundingRates` selector):
 *   factor > 0 → longs are dominant, longs pay funding, shorts receive
 *   factor < 0 → shorts are dominant, shorts pay funding, longs receive
 *
 * This mirrors the standard perp convention (positive = longs pay). The
 * skew adjustment that makes the receiver's per-position rate larger than
 * the payer's is applied in `computeFundingRateLong` below.
 */
async function fetchFundingFactorPerSecond(marketToken: string): Promise<bigint> {
  const json = await safeFetch<{ data?: { fundingRateHourlies?: Array<{ fundingFactorPerSecond: string }> } }>(
    GMTRADE_SQUID,
    `GMTrade funding for ${marketToken.slice(0, 6)}…`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          fundingRateHourlies(
            where: { marketToken_eq: ${JSON.stringify(marketToken)} },
            orderBy: timestamp_DESC, limit: 1
          ) { fundingFactorPerSecond }
        }`,
      }),
    },
  );
  const row = json?.data?.fundingRateHourlies?.[0];
  if (!row?.fundingFactorPerSecond) return BigInt(0);
  try {
    return BigInt(row.fundingFactorPerSecond);
  } catch {
    return BigInt(0);
  }
}

/**
 * Compute the **long-side funding rate as a per-hour fraction**, matching the
 * gmtrade.xyz UI's "Funding Rates" line (which uses `selectFundingRates`).
 *
 * Bundle reference:
 *   mt = factor >= 0
 *   bt = |factor * (mt ? OI_long : OI_short)|
 *   fundingRateLong  = (mt ? -bt : bt) / OI_long          // per-second
 *   fundingRateShort = (mt ?  bt :-bt) / OI_short
 * Displayed value: rate * 3600 (1h), then formatted as a percentage.
 *
 * We report the long-side rate as a signed fraction:
 *   > 0  → longs receive funding (shorts pay)
 *   < 0  → longs pay funding (shorts receive)
 * Note the gmsol UI displays this with "longs pay" shown as negative — the
 * sign is the long-position-PnL contribution, which matches the convention
 * used by the existing hyperliquid/aster adapters.
 */
function computeFundingRate1hLong(factor: bigint, oiLong: bigint, oiShort: bigint): number {
  const zero = BigInt(0);
  if (factor === zero || oiLong === zero || oiShort === zero) return 0;
  const mt = factor >= zero;
  const factAbs = factor < zero ? -factor : factor;
  const bt = factAbs * (mt ? oiLong : oiShort);                  // 1e40 scale
  const ratePerSecScaled = (mt ? -bt : bt) / oiLong;             // 1e20-scaled per-sec
  // ratePerSecScaled is small (~1e9 to 1e12 in practice), safe to convert.
  return (Number(ratePerSecScaled) * 3600) / Number(USD_SCALE);
}

/**
 * Fetch the 24h price change (percent) for one index token.
 * Calls the price-candle service with a 1h resolution and takes (last - prev24)/prev24.
 * Returns 0 if the candle service is unreachable or returns fewer than 24 candles.
 */
// Candle OHLC values come as BigInt strings scaled by 1e18 (e.g. WTI close
// "97965000000000000000" = $97.965). Field is `timestamp`, not `time`.
interface PriceCandle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
}

function candlePxToNumber(s: string): number {
  try {
    // BigInt → float64 via division by 1e18; loses sub-cent precision but
    // ample for a percent calc.
    return Number(BigInt(s)) / 1e18;
  } catch {
    return 0;
  }
}

async function fetchPriceChange24h(indexTokenMint: string): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - 26 * 3600; // a bit of slack so we always have 24 candles
  const json = await safeFetch<{ data?: { candles?: PriceCandle[] } }>(
    GMTRADE_PRICE_CANDLE,
    `GMTrade candles for ${indexTokenMint.slice(0, 6)}…`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($i:String!,$r:Int!,$f:Int!,$t:Int!) {
          candles(indexToken:$i, resolution:$r, from:$f, to:$t) {
            timestamp open close
          }
        }`,
        variables: { i: indexTokenMint, r: 3600, f: fromSec, t: nowSec },
      }),
    },
  );
  const candles = json?.data?.candles ?? [];
  if (candles.length < 2) return 0;
  const ref = candlePxToNumber(candles[0].open);
  const last = candlePxToNumber(candles[candles.length - 1].close);
  if (!ref || !Number.isFinite(ref) || !Number.isFinite(last)) return 0;
  return ((last - ref) / ref) * 100;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const gmtradeAdapter: PlatformAdapter = {
  name: "gmtrade",
  // OI we return below is already converted to USD (sums of *TokenAmount fields
  // which gmsol stores in 1e20-scaled USD). Setting `true` tells the prod
  // normalizer not to multiply by markPx again.
  oiIsNotional: true,

  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const [marketInfos, volumeMap] = await Promise.all([
      fetchMarketInfos(),
      fetchLatestVolumePerMarket(),
    ]);
    if (marketInfos.length === 0) return [];

    // First filter to RWAs so OI fetch only fans out across the markets we care about.
    const rwaInfos = marketInfos
      .map((mi) => ({ mi, parsed: parseMarketName(mi.name) }))
      .filter((x): x is { mi: MarketInfo; parsed: NonNullable<ReturnType<typeof parseMarketName>> } =>
        x.parsed !== null && isRwaSymbol(x.parsed.indexSymbol),
      );

    // Per market in parallel: OI (long + short), funding factor, 24h candles.
    interface PerMarket {
      oiLongRaw: bigint;
      oiShortRaw: bigint;
      fundingFactor: bigint;
    }
    const perMarket = new Map<string, PerMarket>();
    const chgBySymbol = new Map<string, number>();
    await Promise.all(
      rwaInfos.map(async ({ mi, parsed }) => {
        const [oi, fundingFactor, chg] = await Promise.all([
          fetchMarketOiRaw(mi.id),
          fetchFundingFactorPerSecond(mi.id),
          fetchPriceChange24h(mi.indexTokenMint),
        ]);
        perMarket.set(mi.id, { oiLongRaw: oi.long, oiShortRaw: oi.short, fundingFactor });
        // First write wins — multiple pool variants of the same index share a price.
        if (!chgBySymbol.has(parsed.indexSymbol)) chgBySymbol.set(parsed.indexSymbol, chg);
      }),
    );

    // Aggregate by canonical index symbol — GMTrade can list multiple pool
    // variants per index (e.g. BTC/USD[USDC-USDC] vs BTC/USD[WSOL-USDC]).
    // RWAs are currently all [USDC-USDC] singletons, but aggregate defensively.
    // For funding, aggregate the raw factor + OI sums and compute on the merged
    // pools — funding is OI-weighted so summing the per-pool 1h rates would be wrong.
    interface Agg {
      indexSymbol: string;
      pythSymbol: string;
      contractSuffix: string;
      openInterest: number;
      volume24h: number;
      oiLongRaw: bigint;
      oiShortRaw: bigint;
      // Use the funding factor from the pool with the most OI as the canonical
      // factor — pool variants of the same index share the same on-chain
      // funding-factor (it's set per market account), so picking any non-zero
      // one is fine. Tracked as the largest by total OI for stability.
      fundingFactor: bigint;
      fundingFactorAnchorOi: bigint;
    }
    const byIndex = new Map<string, Agg>();
    const zero = BigInt(0);

    for (const { mi, parsed } of rwaInfos) {
      const pm = perMarket.get(mi.id);
      const oiLongRaw = pm?.oiLongRaw ?? zero;
      const oiShortRaw = pm?.oiShortRaw ?? zero;
      const oiTotalRaw = oiLongRaw + oiShortRaw;
      const ff = pm?.fundingFactor ?? zero;
      const vol = bigIntToUsd(volumeMap.get(mi.id)?.volume24h);

      const existing = byIndex.get(parsed.indexSymbol);
      if (existing) {
        existing.openInterest += rawToUsd(oiTotalRaw);
        existing.volume24h += vol;
        existing.oiLongRaw += oiLongRaw;
        existing.oiShortRaw += oiShortRaw;
        if (oiTotalRaw > existing.fundingFactorAnchorOi) {
          existing.fundingFactor = ff;
          existing.fundingFactorAnchorOi = oiTotalRaw;
        }
      } else {
        byIndex.set(parsed.indexSymbol, {
          indexSymbol: parsed.indexSymbol,
          pythSymbol: parsed.pythSymbol,
          contractSuffix: parsed.contractSuffix,
          openInterest: rawToUsd(oiTotalRaw),
          volume24h: vol,
          oiLongRaw,
          oiShortRaw,
          fundingFactor: ff,
          fundingFactorAnchorOi: oiTotalRaw,
        });
      }
    }

    const markets: ParsedPerpsMarket[] = [];
    for (const agg of byIndex.values()) {
      markets.push({
        contract: `gmtrade:${agg.contractSuffix}`,
        venue: "gmtrade",
        platform: "gmtrade",
        openInterest: agg.openInterest,
        volume24h: agg.volume24h,
        markPx: 0, // Filled below from Pyth (with Ostium fallback)
        oraclePx: 0,
        midPx: 0,
        prevDayPx: 0,
        priceChange24h: chgBySymbol.get(agg.indexSymbol) ?? 0,
        // 1h fraction; > 0 = longs receive, < 0 = longs pay. Matches the
        // gmsol UI's "Funding Rates" line (the UI's "Net Rate" combines this
        // with the borrowing factor, which we don't surface separately).
        fundingRate: computeFundingRate1hLong(agg.fundingFactor, agg.oiLongRaw, agg.oiShortRaw),
        // GMX-V2-derived design: mark price = oracle price ± dynamic price
        // impact applied at trade execution. There is no persistent premium
        // between mark and oracle outside of an order, so this is 0 by design.
        premium: 0,
        // Docs cap RWA leverage at 500× during trading hours. The on-chain
        // per-market `minCollateralFactor` could give a tighter dynamic cap
        // (`1 / minCollateralFactor`, decreasing as OI grows toward capacity),
        // but it lives in the Borsh-encoded keeper-API `market` account —
        // decoding requires the Anchor IDL we don't yet vendor. Using the
        // documented upper bound until that's wired up.
        maxLeverage: 500,
        szDecimals: 0,
      });
    }

    if (markets.length === 0) return markets;

    // Fetch prices via Pyth (handles overnight/pre/post sessions for equities).
    const pythSymbols = [
      ...new Set(
        [...byIndex.values()].map((a) => a.pythSymbol.toUpperCase()),
      ),
    ];
    const pythPrices = await fetchPythPricesBySymbol(pythSymbols);

    // Match each market back to its Pyth price using the alias map.
    for (const m of markets) {
      const indexSymbol = m.contract.split(":")[1]?.split("-")[0] ?? "";
      const pythSymbol = (PYTH_SYMBOL_ALIASES[indexSymbol] ?? indexSymbol).toUpperCase();
      const price = pythPrices.get(pythSymbol) ?? 0;
      if (price > 0) {
        m.markPx = price;
        m.oraclePx = price;
        m.midPx = price;
      }
    }

    // For anything Pyth missed (USD-base FX, WTI crude, copper), try Ostium.
    await applyOstiumFallbackPrices(markets, (m, ostiumPrices) => {
      const indexSymbol = m.contract.split(":")[1]?.split("-")[0] ?? "";
      const aliased = OSTIUM_KEY_ALIASES[indexSymbol];
      if (aliased) return ostiumPrices.get(aliased) ?? 0;
      return ostiumPrices.get(`${indexSymbol}USD`) ?? 0;
    });

    return markets;
  },

  async fetchFundingHistory(): Promise<FundingEntry[]> {
    // Funding history is available in the squid via `fundingRateHourlies` but
    // we haven't decoded the per-second rate scaling yet. Return empty for now.
    return [];
  },
};
