export type HomepageUnlockEvent = {
  timestamp?: number | null;
  noOfTokens?: number[] | null;
};

export type HomepageUnlockProtocol = {
  name: string;
  gecko_id?: string | null;
  events?: HomepageUnlockEvent[] | null;
};

export type HomepageUnlockPrice = {
  price?: number | null;
  symbol?: string | null;
};

export type HomepageUnlocksSummary = {
  schemaVersion: 1;
  generatedAtSec: number;
  windowDays: number;
  chart: Array<{
    date: number;
    total: number;
    breakdown: Array<{ token: string; value: number; pct: string }>;
  }>;
  total14d: number;
};

const DEFAULT_WINDOW_DAYS = 14;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sumTokenAmounts(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const amount of value) {
    if (isFiniteNumber(amount)) total += amount;
  }
  return total;
}

function hasUpcomingUnlock(protocol: HomepageUnlockProtocol, nowSec: number, windowDays: number): boolean {
  const windowEndSec = nowSec + windowDays * 24 * 60 * 60;
  for (const event of protocol.events ?? []) {
    const timestamp = event?.timestamp;
    if (!isFiniteNumber(timestamp) || timestamp < nowSec || timestamp >= windowEndSec) continue;
    const totalTokens = sumTokenAmounts(event.noOfTokens);
    if (totalTokens > 0) return true;
  }
  return false;
}

function eventUtcDayMs(timestampSec: number): number {
  return Math.floor(timestampSec / 86400) * 86400 * 1000;
}

export function collectHomepageUnlockCoinIds({
  protocols,
  nowSec,
  windowDays = DEFAULT_WINDOW_DAYS,
}: {
  protocols: HomepageUnlockProtocol[];
  nowSec: number;
  windowDays?: number;
}): string[] {
  const coinIds = new Set<string>();
  for (const protocol of protocols) {
    if (!protocol.gecko_id) continue;
    if (hasUpcomingUnlock(protocol, nowSec, windowDays)) {
      coinIds.add(`coingecko:${protocol.gecko_id}`);
    }
  }
  return Array.from(coinIds);
}

export function buildHomepageUnlocksSummary({
  protocols,
  prices,
  nowSec,
  windowDays = DEFAULT_WINDOW_DAYS,
}: {
  protocols: HomepageUnlockProtocol[];
  prices: Record<string, HomepageUnlockPrice | undefined>;
  nowSec: number;
  windowDays?: number;
}): HomepageUnlocksSummary {
  const windowEndSec = nowSec + windowDays * 24 * 60 * 60;
  const unlocksByDay: Record<number, Record<string, number>> = {};
  let total14d = 0;

  for (const protocol of protocols) {
    if (!protocol.gecko_id) continue;
    const coin = prices[`coingecko:${protocol.gecko_id}`];
    if (!isFiniteNumber(coin?.price) || coin.price <= 0) continue;
    const token = coin.symbol || protocol.name;

    for (const event of protocol.events ?? []) {
      const timestamp = event?.timestamp;
      if (!isFiniteNumber(timestamp) || timestamp < nowSec || timestamp >= windowEndSec) continue;

      const totalTokens = sumTokenAmounts(event.noOfTokens);
      if (totalTokens <= 0) continue;

      const valueUSD = Number((totalTokens * coin.price).toFixed(2));
      if (!isFiniteNumber(valueUSD) || valueUSD <= 0) continue;

      const day = eventUtcDayMs(timestamp);
      const dayUnlocks = (unlocksByDay[day] ??= {});
      dayUnlocks[token] = (dayUnlocks[token] ?? 0) + valueUSD;
      total14d += valueUSD;
    }
  }

  const chart = Object.entries(unlocksByDay)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([date, tokens]) => {
      const entries = Object.entries(tokens).sort((a, b) => b[1] - a[1]);
      const others = entries.slice(10).reduce((sum, [, value]) => sum + value, 0);
      const topEntries: Array<[string, number]> = entries
        .slice(0, 10)
        .concat(others > 0 ? [["Others", others] as [string, number]] : []);
      const total = topEntries.reduce((sum, [, value]) => sum + value, 0);

      return {
        date: Number(date),
        total,
        breakdown: topEntries
          .filter(([, value]) => value > 0)
          .map(([token, value]) => ({
            token,
            value,
            pct: total > 0 ? ((value / total) * 100).toFixed(2) : "0",
          })),
      };
    });

  return {
    schemaVersion: 1,
    generatedAtSec: nowSec,
    windowDays,
    chart,
    total14d,
  };
}
