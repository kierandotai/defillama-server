import { rwaSlug, toFiniteNumberOrZero } from './utils';

export type RwaChartGuardMetadata = {
  id: string;
  data: {
    canonicalMarketId?: string;
    parentPlatform?: string;
    stablecoin?: boolean;
    governance?: boolean;
    type?: string;
    category?: string[];
  };
};

export type RwaChartGuardOptions = {
  minSinglePointMcap: number;
  minDayDelta: number;
  minDayRatio: number;
  maxItems: number;
  lookbackDays: number;
};

export type RwaSinglePointAsset = {
  canonicalMarketId: string;
  count: number;
  timestamp: number;
  value: number;
};

export type RwaAggregateJump = {
  timestamp: number;
  previousTimestamp: number;
  previousTotal: number;
  total: number;
  delta: number;
  ratio: number;
  direction: 'up' | 'down';
  contributors: Array<{ canonicalMarketId: string; previous: number; current: number; delta: number }>;
};

export type RwaHistoricalChartGuardReport = {
  singlePointAssets: RwaSinglePointAsset[];
  aggregateJumps: RwaAggregateJump[];
};

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function timestampToDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function isDefaultRwaChartAsset(m: RwaChartGuardMetadata): boolean {
  const data = m.data || {};
  const canonicalMarketId = data.canonicalMarketId;
  if (!canonicalMarketId) return false;
  if (data.stablecoin === true || data.governance === true) return false;
  if (String(data.type || '').trim().toLowerCase() === 'wrapper') return false;
  const categories = Array.isArray(data.category) ? data.category : [];
  if (categories.some((category: string) => rwaSlug(category) === 'rwa-perps')) return false;
  return true;
}

export function sortedBreakdownRows(map: { [timestamp: string]: any } | undefined): any[] {
  if (!map) return [];
  return Object.entries(map)
    .map(([timestamp, values]) => ({ timestamp: Number(timestamp), ...(values as any) }))
    .filter((row) => Number.isFinite(row.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function sumBreakdownRow(row: any, allowedKeys: Set<string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    if (key === 'timestamp' || !allowedKeys.has(key)) continue;
    total += toFiniteNumberOrZero(value);
  }
  return total;
}

export function findSinglePointLargeAssets(
  rows: any[],
  metadataByKey: Map<string, RwaChartGuardMetadata>,
  minSinglePointMcap: number
): RwaSinglePointAsset[] {
  const seen: { [canonicalMarketId: string]: { count: number; timestamp: number; value: number } } = {};
  for (const row of rows) {
    for (const [key, rawValue] of Object.entries(row)) {
      if (key === 'timestamp' || !metadataByKey.has(key)) continue;
      const value = toFiniteNumberOrZero(rawValue);
      if (value <= 0) continue;
      const existing = seen[key] || { count: 0, timestamp: 0, value: 0 };
      existing.count++;
      existing.timestamp = Number(row.timestamp);
      existing.value = value;
      seen[key] = existing;
    }
  }

  return Object.entries(seen)
    .filter(([, info]) => info.count === 1 && info.value >= minSinglePointMcap)
    .map(([canonicalMarketId, info]) => ({ canonicalMarketId, ...info }))
    .sort((a, b) => b.value - a.value);
}

export function findLargeAggregateJumps(
  rows: any[],
  allowedKeys: Set<string>,
  options: Pick<RwaChartGuardOptions, 'minDayDelta' | 'minDayRatio' | 'maxItems'>
): RwaAggregateJump[] {
  const jumps: RwaAggregateJump[] = [];

  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    const previousTotal = sumBreakdownRow(previous, allowedKeys);
    const total = sumBreakdownRow(current, allowedKeys);
    const delta = total - previousTotal;
    const absDelta = Math.abs(delta);
    const ratio = previousTotal > 0 ? delta / previousTotal : delta === 0 ? 0 : 1;
    const absRatio = Math.abs(ratio);

    if (absDelta < options.minDayDelta || absRatio < options.minDayRatio) continue;

    const contributors = Array.from(allowedKeys)
      .map((canonicalMarketId) => {
        const prevValue = toFiniteNumberOrZero(previous[canonicalMarketId]);
        const currentValue = toFiniteNumberOrZero(current[canonicalMarketId]);
        return { canonicalMarketId, previous: prevValue, current: currentValue, delta: currentValue - prevValue };
      })
      .filter((item) => delta > 0 ? item.delta > 0 : item.delta < 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, options.maxItems);

    jumps.push({
      timestamp: current.timestamp,
      previousTimestamp: previous.timestamp,
      previousTotal,
      total,
      delta,
      ratio,
      direction: delta > 0 ? 'up' : 'down',
      contributors,
    });
  }

  return jumps.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export function getSuspiciousRwaHistoricalChartReport(
  allChainAssetBreakdown: { onChainMcap?: { [timestamp: string]: any } } | undefined,
  metadata: RwaChartGuardMetadata[],
  options: RwaChartGuardOptions
): RwaHistoricalChartGuardReport {
  const metadataByKey = new Map<string, RwaChartGuardMetadata>();
  for (const m of metadata) {
    if (isDefaultRwaChartAsset(m)) metadataByKey.set(m.data.canonicalMarketId!, m);
  }

  const rows = sortedBreakdownRows(allChainAssetBreakdown?.onChainMcap);
  if (!rows.length || !metadataByKey.size) return { singlePointAssets: [], aggregateJumps: [] };

  const allowedKeys = new Set(metadataByKey.keys());
  const latestTimestamp = rows[rows.length - 1].timestamp;
  const minAlertTimestamp = latestTimestamp - options.lookbackDays * 86400;
  const singlePointAssets = findSinglePointLargeAssets(rows, metadataByKey, options.minSinglePointMcap)
    .filter((item) => item.timestamp >= minAlertTimestamp);
  const aggregateJumps = findLargeAggregateJumps(rows, allowedKeys, options)
    .filter((jump) => jump.timestamp >= minAlertTimestamp);

  return { singlePointAssets, aggregateJumps };
}

export function hasSuspiciousRwaHistoricalChartReport(report: RwaHistoricalChartGuardReport): boolean {
  return report.singlePointAssets.length > 0 || report.aggregateJumps.length > 0;
}

export function formatRwaHistoricalChartGuardReport(
  report: RwaHistoricalChartGuardReport,
  metadata: RwaChartGuardMetadata[],
  options: RwaChartGuardOptions
): string {
  const metadataByKey = new Map<string, RwaChartGuardMetadata>();
  for (const m of metadata) {
    if (m.data?.canonicalMarketId) metadataByKey.set(m.data.canonicalMarketId, m);
  }

  const lines: string[] = [
    'Suspicious RWA historical chart shape detected before cache publish.',
    `Lookback: ${options.lookbackDays}d. Thresholds: single-point asset >= ${formatUsd(options.minSinglePointMcap)}, aggregate daily move >= ${formatUsd(options.minDayDelta)} and ${(options.minDayRatio * 100).toFixed(1)}%.`,
  ];

  if (report.singlePointAssets.length) {
    lines.push('');
    lines.push(`Single-point assets (${report.singlePointAssets.length}):`);
    for (const item of report.singlePointAssets.slice(0, options.maxItems)) {
      const meta = metadataByKey.get(item.canonicalMarketId);
      lines.push(
        `- ${item.canonicalMarketId} #${meta?.id ?? '?'} ${meta?.data?.parentPlatform ?? ''}: ` +
        `${formatUsd(item.value)} on ${timestampToDay(item.timestamp)}`
      );
    }
    if (report.singlePointAssets.length > options.maxItems) {
      lines.push(`...and ${report.singlePointAssets.length - options.maxItems} more single-point assets`);
    }
  }

  if (report.aggregateJumps.length) {
    lines.push('');
    lines.push(`Large aggregate moves (${report.aggregateJumps.length}):`);
    for (const jump of report.aggregateJumps.slice(0, 3)) {
      lines.push(
        `- ${jump.direction.toUpperCase()} ${timestampToDay(jump.previousTimestamp)} -> ${timestampToDay(jump.timestamp)}: ` +
        `${formatUsd(jump.previousTotal)} -> ${formatUsd(jump.total)} (${formatUsd(jump.delta)}, ${(jump.ratio * 100).toFixed(1)}%)`
      );
      for (const item of jump.contributors.slice(0, 5)) {
        const meta = metadataByKey.get(item.canonicalMarketId);
        lines.push(
          `  - ${item.canonicalMarketId} #${meta?.id ?? '?'} ${formatUsd(item.previous)} -> ${formatUsd(item.current)} (${formatUsd(item.delta)})`
        );
      }
    }
  }

  return lines.join('\n');
}
