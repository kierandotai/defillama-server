import type { PlatformAdapter, FundingEntry, ParsedPerpsMarket } from "../types";
import { safeFloat, safeFetch } from "../types";

// Apex Omni — public perpetual markets API.
// Docs/endpoints provided by Apex:
//   https://omni.apex.exchange/api/v3/all-open-tickers
//   https://omni.apex.exchange/api/v3/symbols
// RWA assets live in `contractConfig.stockContract` with category
// STOCK | COMMODITY | INDEX. Most market data and fees come from
// all-open-tickers. Apex's own trade UI also reads the public
// /data/all-ticker-mixture endpoint for mark price and 24h change.

export const APEX_MAKER_FEE = 0.0002;
export const APEX_TAKER_FEE = 0.0005;

const APEX_API = "https://omni.apex.exchange/api/v3";
const RWA_CATEGORIES = new Set(["STOCK", "COMMODITY", "INDEX"]);

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface ApexContract {
  baseTokenId: string;
  category?: string | null;
  contractType?: string;
  displayMaxLeverage?: string;
  enableDisplay?: boolean;
  enableOpenPosition?: boolean;
  enableTrade?: boolean;
  settleAssetId: string;
  stepSize?: string;
  symbol: string; // e.g. "USO-USDT"
  symbolDisplayName?: string; // e.g. "USOUSDT"
  tokenName?: string;
}

interface ApexSymbolsResponse {
  data?: {
    contractConfig?: {
      stockContract?: ApexContract[];
    };
  };
}

export interface ApexTicker {
  ticker_id: string; // e.g. "USOUSDT"
  base_currency?: string;
  target_currency?: string;
  funding_rate?: string | number;
  high?: string | number;
  low?: string | number;
  open_interest?: string | number;
  open_interest_usd?: string | number;
  index_price?: string | number;
  last_price?: string | number;
  contract_price?: string | number;
  target_volume?: string | number;
  usd_volume?: string | number;
  base_volume?: string | number;
  maker_fee?: string | number | null;
  taker_fee?: string | number | null;
  bid?: string | number;
  ask?: string | number;
}

interface ApexTickersResponse {
  data?: ApexTicker[];
}

export interface ApexUiTicker {
  symbol: string; // e.g. "USOUSDT"
  fundingRate?: string | number;
  highPrice24h?: string | number;
  indexPrice?: string | number;
  lastPrice?: string | number;
  lowPrice24h?: string | number;
  markPrice?: string | number;
  openInterest?: string | number;
  price24hPcnt?: string | number; // ratio, e.g. 0.013 means +1.3%
  turnover24h?: string | number;
  volume24h?: string | number;
}

interface ApexUiTickersResponse {
  data?: ApexUiTicker[];
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchApexSymbols(): Promise<ApexContract[]> {
  const data = await safeFetch<ApexSymbolsResponse>(`${APEX_API}/symbols`, "Apex symbols");
  return data?.data?.contractConfig?.stockContract ?? [];
}

async function fetchApexTickers(): Promise<ApexTicker[]> {
  const data = await safeFetch<ApexTickersResponse>(`${APEX_API}/all-open-tickers`, "Apex all-open-tickers");
  return data?.data ?? [];
}

async function fetchApexUiTickers(): Promise<ApexUiTicker[]> {
  const data = await safeFetch<ApexUiTickersResponse>(`${APEX_API}/data/all-ticker-mixture`, "Apex all-ticker-mixture");
  return data?.data ?? [];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function isRwaContract(c: ApexContract): boolean {
  if (!c.enableDisplay || !c.enableTrade || !c.enableOpenPosition) return false;
  if (c.contractType !== "STOCK_CONTRACT") return false;
  return RWA_CATEGORIES.has(c.category ?? "");
}

function tickerKey(c: ApexContract): string {
  if (c.symbolDisplayName) return c.symbolDisplayName;
  return `${c.baseTokenId}${c.settleAssetId}`.replace(/[^A-Za-z0-9]/g, "");
}

function decimalPlacesFromStep(step: string | undefined): number {
  if (!step) return 0;
  const normalized = step.toLowerCase();
  if (normalized.includes("e-")) {
    const n = Number(normalized.split("e-")[1]);
    return Number.isFinite(n) ? n : 0;
  }
  const [, decimals = ""] = normalized.split(".");
  return decimals.replace(/0+$/, "").length;
}

function optionalFloat(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

function firstPositive(...values: Array<string | number | null | undefined>): number {
  for (const value of values) {
    const num = optionalFloat(value);
    if (num !== null && num > 0) return num;
  }
  return 0;
}

function firstNumber(...values: Array<string | number | null | undefined>): number {
  for (const value of values) {
    const num = optionalFloat(value);
    if (num !== null) return num;
  }
  return 0;
}

function feeOrFallback(value: string | number | null | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  return safeFloat(value);
}

export function parseApexMarkets(
  contracts: ApexContract[],
  tickers: ApexTicker[],
  uiTickers: ApexUiTicker[] = [],
): ParsedPerpsMarket[] {
  const tickerById = new Map<string, ApexTicker>();
  for (const ticker of tickers) tickerById.set(ticker.ticker_id, ticker);

  const uiTickerBySymbol = new Map<string, ApexUiTicker>();
  for (const ticker of uiTickers) uiTickerBySymbol.set(ticker.symbol, ticker);

  const markets: ParsedPerpsMarket[] = [];
  for (const contract of contracts) {
    if (!isRwaContract(contract)) continue;

    const key = tickerKey(contract);
    const ticker = tickerById.get(key);
    if (!ticker) continue;

    const uiTicker = uiTickerBySymbol.get(key);
    const lastPx = firstPositive(uiTicker?.lastPrice, ticker.last_price, ticker.contract_price);
    const markPx = firstPositive(uiTicker?.markPrice, lastPx);
    const indexPx = firstPositive(uiTicker?.indexPrice, ticker.index_price);
    const bid = safeFloat(ticker.bid);
    const ask = safeFloat(ticker.ask);
    const midPx = bid > 0 && ask > 0 ? (bid + ask) / 2 : markPx;
    const priceChangeRatio = firstNumber(uiTicker?.price24hPcnt);
    const prevDayPx = lastPx > 0 && priceChangeRatio > -1 ? lastPx / (1 + priceChangeRatio) : 0;
    const premium = markPx > 0 && indexPx > 0 ? (markPx - indexPx) / indexPx : 0;

    markets.push({
      contract: `apex:${contract.baseTokenId}`,
      venue: "apex",
      platform: "apex",
      // Apex provides open_interest_usd directly; use it as the normalized OI.
      openInterest: safeFloat(ticker.open_interest_usd),
      volume24h: firstPositive(uiTicker?.turnover24h, ticker.usd_volume, ticker.target_volume),
      markPx,
      oraclePx: indexPx,
      midPx,
      prevDayPx,
      priceChange24h: priceChangeRatio * 100,
      fundingRate: firstNumber(uiTicker?.fundingRate, ticker.funding_rate),
      premium,
      maxLeverage: safeFloat(contract.displayMaxLeverage),
      szDecimals: decimalPlacesFromStep(contract.stepSize),
      makerFeeRate: feeOrFallback(ticker.maker_fee, APEX_MAKER_FEE),
      takerFeeRate: feeOrFallback(ticker.taker_fee, APEX_TAKER_FEE),
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const apexAdapter: PlatformAdapter = {
  name: "apex",
  oiIsNotional: true,
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const [contracts, tickers, uiTickers] = await Promise.all([
      fetchApexSymbols(),
      fetchApexTickers(),
      fetchApexUiTickers(),
    ]);
    if (contracts.length === 0 || tickers.length === 0) return [];
    return parseApexMarkets(contracts, tickers, uiTickers);
  },
  async fetchFundingHistory(): Promise<FundingEntry[]> {
    // Apex exposes current/next funding on all-open-tickers, but no public
    // unauthenticated historical funding endpoint was provided.
    return [];
  },
};
