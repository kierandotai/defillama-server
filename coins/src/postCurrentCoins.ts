import { errorResponse, successResponse, wrap, IResponse } from "./utils/shared";
import parseRequestBody from "./utils/shared/parseRequestBody";
import { currentPricesExpiresHeaders, getCurrentCoins } from "./getCurrentCoins";
import { quantisePeriod } from "./utils/timestampUtils";

export const MAX_CURRENT_PRICE_COINS_PER_BATCH = 100000;

type CurrentPricesRequestBody = {
  coins?: unknown;
  searchWidth?: unknown;
};

function parseBody(value: unknown): CurrentPricesRequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as CurrentPricesRequestBody;
}

function parseCoins(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const coins = value.flatMap((coin) => {
    if (typeof coin !== "string") return [];
    const trimmed = coin.trim();
    return trimmed ? [trimmed] : [];
  });
  return coins.length === value.length && coins.length > 0 ? coins : null;
}

function parseSearchWidth(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const searchWidth = quantisePeriod(trimmed.toLowerCase());
  return Number.isFinite(searchWidth) && searchWidth > 0 ? searchWidth : null;
}

const handler = async (event: any): Promise<IResponse> => {
  let rawBody: unknown;
  try {
    rawBody = parseRequestBody(event.body ?? null);
  } catch (e) {
    return errorResponse({ message: e instanceof Error ? e.message : "Invalid request body" });
  }

  const body = parseBody(rawBody);
  if (!body) {
    return errorResponse({ message: "Request body must be a JSON object" });
  }

  const requestedCoins = parseCoins(body.coins);
  if (!requestedCoins) {
    return errorResponse({ message: "coins must be an array of non-empty strings" });
  }

  if (requestedCoins.length > MAX_CURRENT_PRICE_COINS_PER_BATCH) {
    return errorResponse({ message: `coins: max ${MAX_CURRENT_PRICE_COINS_PER_BATCH} per batch` });
  }

  const searchWidth = parseSearchWidth(body.searchWidth);
  if (searchWidth === null) {
    return errorResponse({ message: 'searchWidth must be a duration like "4h" or "12h"' });
  }
  const response = await getCurrentCoins({ requestedCoins, ...(searchWidth !== undefined ? { searchWidth } : {}) });

  return successResponse({ coins: response }, undefined, currentPricesExpiresHeaders());
};

export default wrap(handler);
