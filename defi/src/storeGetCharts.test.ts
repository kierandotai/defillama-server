import { getChainDefaultChartData } from "./storeGetCharts";

describe("getChainDefaultChartData", () => {
  it("does not emit negative chain TVL from rounded excluded sections", () => {
    const chart = getChainDefaultChartData({
      tvl: [["1778284800", 1272372]],
      liquidstaking: [["1778284800", 1027410]],
      doublecounted: [["1778284800", 244963]],
    });

    expect(chart).toEqual([{ date: 1778284800, tvl: 0 }]);
  });

  it("keeps positive chain TVL after exclusions", () => {
    const chart = getChainDefaultChartData({
      tvl: [["1778284800", 1272380]],
      liquidstaking: [["1778284800", 1027410]],
      doublecounted: [["1778284800", 244963]],
    });

    expect(chart).toEqual([{ date: 1778284800, tvl: 7 }]);
  });

  it("adds back overlapping liquid staking and double-counted TVL", () => {
    const chart = getChainDefaultChartData({
      tvl: [["1778284800", 1000000]],
      liquidstaking: [["1778284800", 300000]],
      doublecounted: [["1778284800", 300000]],
      dcAndLsOverlap: [["1778284800", 300000]],
    });

    expect(chart).toEqual([{ date: 1778284800, tvl: 700000 }]);
  });
});
