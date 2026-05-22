import type { FundingEntry, ParsedPerpsMarket, PlatformAdapter } from "../types";
import { safeFetch, safeFloat } from "../types";

// Parcl v3 — Solana
// Docs: https://docs.parcl.co
// API: https://express-prod.parcl-api.com/v1 (the internal API used by app.parcl.co;
// requires an `Origin: https://app.parcl.co` header or all routes reject with 401).
// RWA assets: synthetic real-estate price perps tied to Parcl Labs metro indices.
// Margin/settlement: USDC | Oracle: Pyth feeding Parcl Labs price feeds.

const PARCL_API = "https://express-prod.parcl-api.com/v1";
const PARCL_ORIGIN = "https://app.parcl.co";
const PARCL_FETCH_INIT: RequestInit = { headers: { Origin: PARCL_ORIGIN } };

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface ParclMarket {
  marketId: number;
  name: string;
  address: string;
  parclId: number | null;
  priceFeed: string;
  isNew: boolean;
  tradable: boolean;
  symbol: string;
  marketCategory: string | null;
  currency: string | null;
  metric: string | null;
  pythTokenId: string | null;
  marketPrice: number | null;
  indexPrice: number | null;
  fundingPerUnit: number | null;
  skew: number | null;
  marketSize: number | null;
  fundingRate: number | null;
  fundingVelocity: number | null;
  totalOpenInterest: number | null;
  volume: number | null;
  marketPriceTrend: number | null;
  indexPriceTrend: number | null;
  tags?: string[];
  longPct: number | null;
  shortPct: number | null;
}

interface ParclMarketSearchResponse {
  markets?: ParclMarket[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseParclMarkets(rawMarkets: ParclMarket[]): ParsedPerpsMarket[] {
  const markets: ParsedPerpsMarket[] = [];

  for (const m of rawMarkets) {
    // Only ingest live real-estate markets. The /market/search payload also
    // contains placeholder rows for unlisted markets (no marketId, all metrics
    // null) and crypto reference tokens (ETH-USD, PRCL-USD) we don't want.
    if (m.marketCategory !== "real-estate") continue;
    if (m.marketPrice == null || m.totalOpenInterest == null) continue;

    const markPx = safeFloat(m.marketPrice);
    const oraclePx = safeFloat(m.indexPrice);
    // OI is in base-asset units (square feet for sales markets); the pipeline
    // multiplies by markPx to get USD notional (oiIsNotional=false).
    const openInterest = safeFloat(m.totalOpenInterest);

    const premium = oraclePx > 0 ? (markPx - oraclePx) / oraclePx : 0;

    markets.push({
      contract: `parcl:${m.symbol}`,
      venue: "parcl",
      platform: "parcl",
      openInterest,
      // /market/search and /market/{symbol} both currently return null for
      // volume on Parcl's API. Leave 0 until the venue populates it.
      volume24h: 0,
      markPx,
      oraclePx,
      midPx: 0,
      prevDayPx: 0,
      priceChange24h: 0,
      fundingRate: safeFloat(m.fundingRate),
      premium,
      maxLeverage: null,
      szDecimals: 0,
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchParclMarkets(): Promise<ParclMarket[]> {
  const data = await safeFetch<ParclMarketSearchResponse>(
    `${PARCL_API}/market/search?window=1d`,
    "Parcl market search",
    PARCL_FETCH_INIT,
  );
  return data?.markets ?? [];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const parclAdapter: PlatformAdapter = {
  name: "parcl",
  oiIsNotional: false,
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const raw = await fetchParclMarkets();
    if (raw.length === 0) return [];
    return parseParclMarkets(raw);
  },
  async fetchFundingHistory(): Promise<FundingEntry[]> {
    // Parcl's market-time-series endpoint is currently unpopulated and there's
    // no documented funding-history route. Skip.
    return [];
  },
};
