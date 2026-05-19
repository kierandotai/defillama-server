import {
  detectSpikes,
  collectHistoricalVolumes,
  median,
  VolumeCache,
  DailyVolume,
} from './storeStablecoinVolume';

const DAY = 24 * 3600;
const SPIKE_RATIO = 1000;
const SPIKE_ABS_FLOOR = 200_000_000;
const SPIKE_MIN_OBS = 10;

// build a fake daily entry with a single (chain, token) volume
function makeDaily(timestamp: number, chain: string, token: string, volume: number): DailyVolume {
  return {
    timestamp,
    chains: { [chain]: { tokens: { [token]: volume }, currencies: {} } },
  };
}

// build a history with N consecutive prior days for a (chain, token), each with `volume`
function buildHistory(targetTs: number, chain: string, token: string, volumes: number[]): VolumeCache {
  const cache: VolumeCache = {};
  // place history strictly before targetTs to mimic real cache shape
  for (let i = 0; i < volumes.length; i++) {
    const ts = targetTs - (i + 1) * DAY;
    cache[String(ts)] = makeDaily(ts, chain, token, volumes[i]);
  }
  return cache;
}

const targetTs = Math.floor(new Date('2026-05-14').getTime() / 1000);

describe('median', () => {
  test('returns 0 for empty array', () => {
    expect(median([])).toBe(0);
  });
  test('odd-length picks middle', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  test('even-length averages two middle elements', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('collectHistoricalVolumes', () => {
  test('excludes the target day even if it has volume for that pair', () => {
    const cache: VolumeCache = {
      [String(targetTs)]: makeDaily(targetTs, 'ethereum', 'USDE', 5_000_000_000),
      [String(targetTs - DAY)]: makeDaily(targetTs - DAY, 'ethereum', 'USDE', 100_000),
    };
    expect(collectHistoricalVolumes(cache, 'ethereum', 'USDE', targetTs)).toEqual([100_000]);
  });

  test('ignores entries with 0, NaN, or missing volumes', () => {
    const cache: VolumeCache = {
      [String(targetTs - 1 * DAY)]: makeDaily(targetTs - 1 * DAY, 'ethereum', 'USDE', 100_000),
      [String(targetTs - 2 * DAY)]: makeDaily(targetTs - 2 * DAY, 'ethereum', 'USDE', 0),
      [String(targetTs - 3 * DAY)]: { timestamp: targetTs - 3 * DAY, chains: {} },
      [String(targetTs - 4 * DAY)]: makeDaily(targetTs - 4 * DAY, 'ethereum', 'USDE', NaN as any),
      [String(targetTs - 5 * DAY)]: makeDaily(targetTs - 5 * DAY, 'ethereum', 'USDE', 200_000),
    };
    expect(collectHistoricalVolumes(cache, 'ethereum', 'USDE', targetTs).sort()).toEqual([100_000, 200_000]);
  });

  test('only picks the requested (chain, token) pair', () => {
    const cache: VolumeCache = {
      [String(targetTs - DAY)]: {
        timestamp: targetTs - DAY,
        chains: {
          ethereum: { tokens: { USDE: 100, USDT: 999 }, currencies: {} },
          base: { tokens: { USDE: 200 }, currencies: {} },
        },
      },
    };
    expect(collectHistoricalVolumes(cache, 'ethereum', 'USDE', targetTs)).toEqual([100]);
    expect(collectHistoricalVolumes(cache, 'base', 'USDE', targetTs)).toEqual([200]);
    expect(collectHistoricalVolumes(cache, 'ethereum', 'USDT', targetTs)).toEqual([999]);
  });
});

describe('detectSpikes', () => {
  test('not flagged when total is below SPIKE_ABS_FLOOR (even if ratio would trip)', () => {
    const totals = new Map([['ethereum|USDE', SPIKE_ABS_FLOOR - 1]]);
    const history = buildHistory(targetTs, 'ethereum', 'USDE', Array(SPIKE_MIN_OBS).fill(100));
    const { spiked, spikes } = detectSpikes(totals, history, targetTs);
    expect(spiked.size).toBe(0);
    expect(spikes).toHaveLength(0);
  });

  test('not flagged when historical observations < SPIKE_MIN_OBS', () => {
    const totals = new Map([['ethereum|USDE', 1_000_000_000_000]]); // huge but no history
    const history = buildHistory(targetTs, 'ethereum', 'USDE', Array(SPIKE_MIN_OBS - 1).fill(100));
    const { spiked } = detectSpikes(totals, history, targetTs);
    expect(spiked.size).toBe(0);
  });

  test('not flagged when ratio < SPIKE_RATIO (gradual growth)', () => {
    // median = 1M, total = 200M → ratio = 200 < 1000 → not a spike
    const totals = new Map([['ethereum|USDE', 200_000_000]]);
    const history = buildHistory(targetTs, 'ethereum', 'USDE', Array(SPIKE_MIN_OBS).fill(1_000_000));
    const { spiked } = detectSpikes(totals, history, targetTs);
    expect(spiked.size).toBe(0);
  });

  test('FLAGGED when all three conditions met: floor, min-obs, ratio', () => {
    // median = 100K, total = 500M → ratio = 5000 >= 1000 AND total >= 200M AND obs = 12 >= 10
    const totals = new Map([['ethereum|USDE', 500_000_000]]);
    const history = buildHistory(targetTs, 'ethereum', 'USDE', Array(12).fill(100_000));
    const { spiked, spikes } = detectSpikes(totals, history, targetTs, { isWhitelisted: () => false });
    expect(spiked.has('ethereum|USDE')).toBe(true);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({
      chain: 'ethereum',
      token: 'USDE',
      volume: 500_000_000,
      median: 100_000,
      ratio: 5000,
      historyN: 12,
      date: '2026-05-14',
    });
  });

  test('whitelist "all" skips a token across any date', () => {
    const totals = new Map([['ethereum|USDE', 500_000_000]]);
    const history = buildHistory(targetTs, 'ethereum', 'USDE', Array(12).fill(100_000));
    const { spiked, spikes } = detectSpikes(totals, history, targetTs, {
      isWhitelisted: (token) => token === 'USDE',
    });
    expect(spiked.size).toBe(0);
    expect(spikes).toHaveLength(0);
  });

  test('whitelist with specific date skips only that date', () => {
    const totals = new Map([['ethereum|USDE', 500_000_000]]);
    const history = buildHistory(targetTs, 'ethereum', 'USDE', Array(12).fill(100_000));
    const isWhitelisted = (token: string, ts: number) =>
      token === 'USDE' && new Date(ts * 1000).toISOString().split('T')[0] === '2026-05-14';

    // on the whitelisted date -> not flagged
    const onDate = detectSpikes(totals, history, targetTs, { isWhitelisted });
    expect(onDate.spiked.size).toBe(0);

    // on another date with same total/history -> flagged
    const otherTs = targetTs + DAY; // 2026-05-15
    const otherHistory = buildHistory(otherTs, 'ethereum', 'USDE', Array(12).fill(100_000));
    const otherDay = detectSpikes(totals, otherHistory, otherTs, { isWhitelisted });
    expect(otherDay.spiked.has('ethereum|USDE')).toBe(true);
  });

  test('only spike pairs are flagged when multiple pairs are evaluated', () => {
    const totals = new Map<string, number>([
      ['ethereum|USDE', 500_000_000],     // will spike
      ['ethereum|USDT', 300_000_000],     // healthy growth, no spike
      ['base|USDC', 250_000_000],          // would-be spike but whitelisted
      ['polygon|TINY', 10_000],            // below floor
    ]);
    const history: VolumeCache = {
      // give each pair its own per-day history
      ...buildHistory(targetTs, 'ethereum', 'USDE', Array(12).fill(100_000)),
    };
    // merge USDT history (high baseline) and USDC history (low baseline) into the same cache
    for (let i = 0; i < 12; i++) {
      const ts = targetTs - (i + 1) * DAY;
      const entry = (history[String(ts)] ||= { timestamp: ts, chains: {} });
      entry.chains.ethereum = entry.chains.ethereum || { tokens: {}, currencies: {} };
      entry.chains.ethereum.tokens.USDT = 100_000_000; // ratio = 3, well below 1000
      entry.chains.base = { tokens: { USDC: 100_000 }, currencies: {} }; // would-be 2500× spike
    }

    const { spiked, spikes } = detectSpikes(totals, history, targetTs, {
      isWhitelisted: (token) => token === 'USDC',
    });
    expect(spiked.size).toBe(1);
    expect(spiked.has('ethereum|USDE')).toBe(true);
    expect(spikes.map(s => s.token)).toEqual(['USDE']);
  });

  test('respects custom thresholds via options', () => {
    // total = 50M (< production 200M floor) but trips a lower custom floor
    const totals = new Map([['ethereum|FOO', 50_000_000]]);
    const history = buildHistory(targetTs, 'ethereum', 'FOO', Array(12).fill(10_000));

    // production-default thresholds -> not flagged (below floor)
    expect(detectSpikes(totals, history, targetTs, { isWhitelisted: () => false }).spiked.size).toBe(0);

    // lowered floor + same ratio -> flagged
    expect(detectSpikes(totals, history, targetTs, {
      isWhitelisted: () => false,
      spikeAbsFloor: 10_000_000,
    }).spiked.has('ethereum|FOO')).toBe(true);

    // strict ratio (e.g. require 10000×) -> not flagged (actual ratio is 5000)
    expect(detectSpikes(totals, history, targetTs, {
      isWhitelisted: () => false,
      spikeAbsFloor: 10_000_000,
      spikeRatio: 10_000,
    }).spiked.size).toBe(0);
  });

  test('median exclusion: target-day history must not influence its own spike check', () => {
    // if the target day itself were counted in median, ratio would collapse to ~1× and miss the spike
    const targetVolume = 500_000_000;
    const totals = new Map([['ethereum|USDE', targetVolume]]);
    // build a cache that includes the target day with the target volume — collectHistoricalVolumes must skip it
    const history: VolumeCache = {
      [String(targetTs)]: makeDaily(targetTs, 'ethereum', 'USDE', targetVolume),
      ...buildHistory(targetTs, 'ethereum', 'USDE', Array(12).fill(100_000)),
    };
    const { spiked, spikes } = detectSpikes(totals, history, targetTs, { isWhitelisted: () => false });
    expect(spiked.has('ethereum|USDE')).toBe(true);
    expect(spikes[0].median).toBe(100_000);
    expect(spikes[0].historyN).toBe(12);
  });
});
