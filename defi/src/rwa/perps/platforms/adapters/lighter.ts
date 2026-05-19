import type { PlatformAdapter, FundingEntry, ParsedPerpsMarket } from "../types";
import { safeFloat, safeFetch } from "../types";

// Lighter — zk-rollup perp DEX
// Docs: https://apidocs.lighter.xyz/docs/get-started
// Swagger: https://mainnet.zklighter.elliot.ai/swagger
// RWA assets: 39+ (equities, indices, ETFs, commodities)
// Margin: USDC | Oracle: multiple
//
// Lighter charges 0% maker/taker fees at the time of writing.
export const LIGHTER_MAKER_FEE = 0;
export const LIGHTER_TAKER_FEE = 0;

const LIGHTER_API = "https://mainnet.zklighter.elliot.ai/api/v1";

// ---------------------------------------------------------------------------
// Raw API types — /orderBookDetails returns every active+inactive market
// with daily volume, price change, and open interest in a single call.
// ---------------------------------------------------------------------------

interface LighterOrderBookDetail {
  symbol: string;
  market_id: number;
  market_type: string; // "perp"
  status: string;      // "active" | "inactive"
  taker_fee: string;
  maker_fee: string;
  size_decimals: number;
  price_decimals: number;
  // Daily ticker (24h rolling)
  last_trade_price: number;
  daily_trades_count?: number;
  daily_base_token_volume?: number;   // base-asset units
  daily_quote_token_volume?: number;  // USD notional
  daily_price_low?: number;
  daily_price_high?: number;
  daily_price_change?: number;        // already a percentage (e.g. 1.84 = +1.84%)
  open_interest?: number;             // base-asset units
  // Margin parameters. `default_*` is what's required to OPEN; `min_*` is the
  // floor a position can be reduced to. Lighter's UI advertises max leverage
  // as 1/min_initial_margin_fraction (e.g. min=200 → 50× on app.lighter.xyz).
  default_initial_margin_fraction?: number;
  min_initial_margin_fraction?: number;
}

interface LighterOrderBookDetailsResponse {
  code: number;
  order_book_details: LighterOrderBookDetail[];
  spot_order_book_details?: unknown[];
}

// Map of canonical contract id ("lighter:<SYMBOL>") to numeric market_id,
// populated by fetchMarkets so fetchFundingHistory can look it up without
// re-hitting /orderBookDetails for every market.
const MARKET_ID_BY_CONTRACT = new Map<string, number>();

interface LighterFundingEntry {
  timestamp: number;   // unix seconds
  value: string;       // funding payment indicator (per Lighter convention)
  rate: string;        // funding rate for the period (e.g. "0.0004" = 0.04%)
  direction: string;   // "long" | "short" — which side paid
}

interface LighterFundingsResponse {
  code: number;
  resolution: string;
  fundings: LighterFundingEntry[];
}

// /api/v1/funding-rates — bulk endpoint, one row per (market_id, exchange).
// Lighter publishes its OWN rate alongside reference rates from binance / bybit /
// hyperliquid; we filter to exchange="lighter" to get the live rate per market.
interface LighterCurrentFundingRate {
  market_id: number;
  exchange: string;
  symbol: string;
  rate: number;
}

interface LighterCurrentFundingRatesResponse {
  code: number;
  funding_rates: LighterCurrentFundingRate[];
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchLighterMarkets(): Promise<LighterOrderBookDetail[]> {
  const data = await safeFetch<LighterOrderBookDetailsResponse>(
    `${LIGHTER_API}/orderBookDetails`,
    "Lighter orderBookDetails",
  );
  return data?.order_book_details ?? [];
}

async function fetchLighterCurrentFundingRates(): Promise<Map<number, number>> {
  const data = await safeFetch<LighterCurrentFundingRatesResponse>(
    `${LIGHTER_API}/funding-rates`,
    "Lighter funding-rates",
  );
  const map = new Map<number, number>();
  for (const r of data?.funding_rates ?? []) {
    if (r.exchange === "lighter") map.set(r.market_id, r.rate);
  }
  return map;
}

// /api/v1/fundings requires ALL FIVE params: market_id, resolution,
// start_timestamp (seconds), end_timestamp (seconds), count_back. Omitting any
// returns {"code":20001,"message":"invalid param"}.
async function fetchLighterFundings(
  marketId: number,
  startSec: number,
  endSec: number,
  countBack: number,
): Promise<LighterFundingEntry[]> {
  const url =
    `${LIGHTER_API}/fundings` +
    `?market_id=${marketId}` +
    `&resolution=1h` +
    `&start_timestamp=${startSec}` +
    `&end_timestamp=${endSec}` +
    `&count_back=${countBack}`;
  const data = await safeFetch<LighterFundingsResponse>(url, `Lighter fundings ${marketId}`);
  return data?.fundings ?? [];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseLighterMarkets(
  raw: LighterOrderBookDetail[],
  fundingRates: Map<number, number>,
): ParsedPerpsMarket[] {
  const markets: ParsedPerpsMarket[] = [];
  MARKET_ID_BY_CONTRACT.clear();

  for (const m of raw) {
    if (m.market_type !== "perp") continue;
    if (m.status !== "active") continue;

    const contract = `lighter:${m.symbol}`;
    MARKET_ID_BY_CONTRACT.set(contract, m.market_id);
    const price = safeFloat(m.last_trade_price);

    // Use min_initial_margin_fraction so leverage matches what app.lighter.xyz
    // advertises (e.g. EURUSD min=200 → 50×, BTC/ETH min=200 → 50×).
    const minImf = safeFloat(m.min_initial_margin_fraction);
    const maxLeverage = minImf > 0 ? 10000 / minImf : 0;

    markets.push({
      contract,
      venue: "lighter",
      platform: "lighter",
      // OI is in base-asset units; pipeline multiplies by markPx for USD notional.
      openInterest: safeFloat(m.open_interest),
      volume24h: safeFloat(m.daily_quote_token_volume),
      markPx: price,
      oraclePx: price,
      midPx: price,
      prevDayPx: 0,
      priceChange24h: safeFloat(m.daily_price_change),
      fundingRate: fundingRates.get(m.market_id) ?? 0,
      premium: 0,
      maxLeverage,
      szDecimals: safeFloat(m.size_decimals),
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const lighterAdapter: PlatformAdapter = {
  name: "lighter",
  oiIsNotional: false, // OI is in base-asset units
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const [raw, fundingRates] = await Promise.all([
      fetchLighterMarkets(),
      fetchLighterCurrentFundingRates(),
    ]);
    if (raw.length === 0) return [];
    return parseLighterMarkets(raw, fundingRates);
  },
  async fetchFundingHistory(
    market: ParsedPerpsMarket,
    startTime: number,
    endTime?: number,
  ): Promise<FundingEntry[]> {
    const marketId = MARKET_ID_BY_CONTRACT.get(market.contract);
    if (marketId === undefined) return [];

    // perps.ts passes startTime/endTime in milliseconds; Lighter speaks seconds.
    const startSec = Math.floor(startTime / 1000);
    const endSec = endTime ? Math.floor(endTime / 1000) : Math.floor(Date.now() / 1000);
    if (startSec >= endSec) return [];

    // Lighter funds hourly. count_back caps how many entries the server returns;
    // size to the window plus a small buffer (max 1 entry/hour, capped at 1000).
    const hours = Math.ceil((endSec - startSec) / 3600);
    const countBack = Math.min(Math.max(hours + 2, 2), 1000);

    const raw = await fetchLighterFundings(marketId, startSec, endSec, countBack);

    const entries: FundingEntry[] = [];
    for (const r of raw) {
      const ts = safeFloat(r.timestamp);
      if (ts < startSec || ts >= endSec) continue;
      const fundingRate = safeFloat(r.rate);
      // funding payment ≈ rate * current OI in base units (mirrors hyperliquid)
      entries.push({
        timestamp: ts,
        contract: market.contract,
        venue: market.venue,
        fundingRate,
        premium: 0,
        openInterest: market.openInterest,
        fundingPayment: fundingRate * market.openInterest,
      });
    }
    return entries;
  },
};
