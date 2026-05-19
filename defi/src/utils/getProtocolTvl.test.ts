jest.mock("../protocols/data", () => ({
  __esModule: true,
  default: [],
  protocolsById: {},
  _InternalProtocolMetadataMap: {
    "doublecounted-protocol": {
      id: "doublecounted-protocol",
      category: "Yield",
      categorySlug: "yield",
      isLiquidStaking: false,
      isDoublecounted: true,
      slugTagSet: new Set(),
      hasTvl: true,
      isDead: false,
      misrepresentedTokens: false,
      hasChainSlug: () => false,
    },
  },
}));

import type { Protocol } from "../protocols/types";
import { getProtocolTvl } from "./getProtocolTvl";

const protocol: Protocol = {
  id: "doublecounted-protocol",
  name: "Doublecounted Protocol",
  category: "Yield",
  address: null,
  symbol: "DCP",
  url: "",
  description: null,
  chain: "Arbitrum",
  logo: null,
  gecko_id: null,
  cmcId: null,
  chains: ["Arbitrum"],
  module: "doublecounted-protocol",
};

describe("getProtocolTvl default chain fallback", () => {
  it("does not backfill default chain tvl when a real chain and an additional aggregate are present", async () => {
    const result = await getProtocolTvl(protocol, true, {
      getLastHourlyRecord: async () => ({ arbitrum: 75, tvl: 100 }),
      getYesterdayTvl: async () => ({ arbitrum: 70, tvl: 90 }),
      getLastWeekTvl: async () => ({ arbitrum: 65, tvl: 80 }),
      getLastMonthTvl: async () => ({ arbitrum: 60, tvl: 70 }),
    });

    expect(result.chainTvls.Arbitrum).toEqual({
      tvl: 75,
      tvlPrevDay: 70,
      tvlPrevWeek: 65,
      tvlPrevMonth: 60,
    });
    expect(result.chainTvls["Arbitrum-doublecounted"]).toEqual({
      tvl: 75,
      tvlPrevDay: 70,
      tvlPrevWeek: 65,
      tvlPrevMonth: 60,
    });
    expect(result.chainTvls.doublecounted).toEqual({
      tvl: 100,
      tvlPrevDay: 90,
      tvlPrevWeek: 80,
      tvlPrevMonth: 70,
    });
  });

  it("still backfills default chain tvl when only additional aggregates are present", async () => {
    const result = await getProtocolTvl(protocol, true, {
      getLastHourlyRecord: async () => ({ tvl: 100 }),
      getYesterdayTvl: async () => ({ tvl: 90 }),
      getLastWeekTvl: async () => ({ tvl: 80 }),
      getLastMonthTvl: async () => ({ tvl: 70 }),
    });

    expect(result.chainTvls).toEqual({
      doublecounted: {
        tvl: 100,
        tvlPrevDay: 90,
        tvlPrevWeek: 80,
        tvlPrevMonth: 70,
      },
      Arbitrum: {
        tvl: 100,
        tvlPrevDay: 90,
        tvlPrevWeek: 80,
        tvlPrevMonth: 70,
      },
      "Arbitrum-doublecounted": {
        tvl: 100,
        tvlPrevDay: 90,
        tvlPrevWeek: 80,
        tvlPrevMonth: 70,
      },
    });
  });
});
