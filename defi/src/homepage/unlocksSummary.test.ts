import { buildHomepageUnlocksSummary, collectHomepageUnlockCoinIds } from "./unlocksSummary";

describe("homepage unlocks summary", () => {
  const nowSec = Date.UTC(2026, 4, 20, 12) / 1000;

  it("collects prices only for protocols with upcoming non-zero unlocks", () => {
    const coinIds = collectHomepageUnlockCoinIds({
      nowSec,
      protocols: [
        {
          name: "Included",
          gecko_id: "included",
          events: [{ timestamp: nowSec + 3600, noOfTokens: [10] }],
        },
        {
          name: "Past",
          gecko_id: "past",
          events: [{ timestamp: nowSec - 3600, noOfTokens: [10] }],
        },
        {
          name: "Zero",
          gecko_id: "zero",
          events: [{ timestamp: nowSec + 3600, noOfTokens: [0] }],
        },
        {
          name: "Outside",
          gecko_id: "outside",
          events: [{ timestamp: nowSec + 15 * 86400, noOfTokens: [10] }],
        },
      ],
    });

    expect(coinIds).toEqual(["coingecko:included"]);
  });

  it("builds a UTC-day chart with top tokens, Others, and total14d", () => {
    const protocols = Array.from({ length: 12 }, (_, index) => ({
      name: `Protocol ${index}`,
      gecko_id: `token-${index}`,
      events: [{ timestamp: nowSec + 3600, noOfTokens: [index + 1] }],
    }));
    protocols.push({
      name: "Fractional Protocol",
      gecko_id: "fractional-token",
      events: [{ timestamp: nowSec + 3600, noOfTokens: [0.004] }],
    });

    const prices = Object.fromEntries(
      protocols.map((protocol, index) => [
        `coingecko:${protocol.gecko_id}`,
        protocol.gecko_id === "fractional-token"
          ? { price: 123.45, symbol: "FRAC" }
          : { price: 2, symbol: `T${index}` },
      ]),
    );

    const summary = buildHomepageUnlocksSummary({ protocols, prices, nowSec });

    expect(summary.schemaVersion).toBe(1);
    expect(summary.generatedAtSec).toBe(nowSec);
    expect(summary.windowDays).toBe(14);
    expect(summary.chart).toHaveLength(1);
    expect(summary.chart[0].date).toBe(Date.UTC(2026, 4, 20));
    expect(summary.chart[0].total).toBe(156.49);
    expect(summary.total14d).toBe(156.49);
    expect(summary.chart[0].breakdown).toHaveLength(11);
    expect(summary.chart[0].breakdown[0]).toEqual({ token: "T11", value: 24, pct: "15.34" });
    expect(summary.chart[0].breakdown[summary.chart[0].breakdown.length - 1]).toEqual({
      token: "Others",
      value: 6.49,
      pct: "4.15",
    });
  });

  it("skips events whose price is missing", () => {
    const summary = buildHomepageUnlocksSummary({
      nowSec,
      protocols: [
        {
          name: "Missing Price",
          gecko_id: "missing",
          events: [{ timestamp: nowSec + 3600, noOfTokens: [10] }],
        },
      ],
      prices: {},
    });

    expect(summary.chart).toEqual([]);
    expect(summary.total14d).toBe(0);
  });
});
