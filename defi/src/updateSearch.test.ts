import {
  DIRECTORY_INDEX_SETTINGS,
  SEARCH_DEPTH_RANK,
  PAGES_INDEX_SETTINGS,
  SEARCH_RANK,
  buildDirectoryResults,
  buildFrontendPageSearchResult,
  buildProtocolSearchResult,
  buildStablecoinSearchResult,
  dedupeFrontendPageResults,
  getFrontendPageRouteAlias,
  getProtocolSubSections,
  shouldSkipProtocolSearchResult,
} from "./updateSearch";

describe("search index settings", () => {
  it("searches route aliases before names and keeps subpage labels display-only", () => {
    const attrs = PAGES_INDEX_SETTINGS.searchableAttributes;

    expect(attrs).toContain("routeAlias");
    expect(attrs.indexOf("routeAlias")).toBeLessThan(attrs.indexOf("name"));
    expect(attrs).not.toContain("subName");
    expect(PAGES_INDEX_SETTINGS.displayedAttributes).toContain("subName");
  });

  it("keeps result depth before exactness and business ranking", () => {
    const rules = PAGES_INDEX_SETTINGS.rankingRules;

    expect(rules.indexOf("topLevelRank:desc")).toBeLessThan(rules.indexOf("exactness"));
    expect(rules.indexOf("exactness")).toBeLessThan(rules.indexOf("r:desc"));
    expect(rules.indexOf("r:desc")).toBeLessThan(rules.indexOf("attribute"));
    expect(rules.indexOf("v:desc")).toBeLessThan(rules.indexOf("sort"));
  });

  it("supports frontend entity filters", () => {
    expect(PAGES_INDEX_SETTINGS.filterableAttributes).toEqual(["type", "deprecated", "subName"]);
  });

  it("keeps fields required by existing search edge cases", () => {
    const attrs = PAGES_INDEX_SETTINGS.searchableAttributes;

    expect(attrs).toEqual(
      expect.arrayContaining(["symbol", "previousNames", "nameVariants", "keywords", "alias1", "alias5"])
    );
    expect(PAGES_INDEX_SETTINGS.sortableAttributes).toContain("mcapRank");
    expect(PAGES_INDEX_SETTINGS.sortableAttributes).toContain("topLevelRank");
  });

  it("keeps directory search scoped to official URL entries", () => {
    expect(DIRECTORY_INDEX_SETTINGS.searchableAttributes).toEqual([
      "name",
      "symbol",
      "previousNames",
      "nameVariants",
      "route",
    ]);
    expect(DIRECTORY_INDEX_SETTINGS.searchableAttributes).not.toEqual(
      expect.arrayContaining(["routeAlias", "keywords", "subName"])
    );
    expect(DIRECTORY_INDEX_SETTINGS.rankingRules.indexOf("exactness")).toBeLessThan(
      DIRECTORY_INDEX_SETTINGS.rankingRules.indexOf("r:desc")
    );
  });
});

describe("frontend page search docs", () => {
  it("adds exact route aliases to single-segment frontend pages", () => {
    const fees = buildFrontendPageSearchResult({
      id: "metric_fees-by-protocol",
      page: { name: "Fees by Protocol", route: "/fees" },
      type: "Metric",
      tastyMetrics: {},
    });
    const revenue = buildFrontendPageSearchResult({
      id: "metric_revenue-by-protocol",
      page: { name: "Revenue by Protocol", route: "/revenue" },
      type: "Metric",
      tastyMetrics: {},
    });
    const holdersRevenue = buildFrontendPageSearchResult({
      id: "metric_holders-revenue-by-protocol",
      page: { name: "Holders Revenue by Protocol", route: "/holders-revenue" },
      type: "Metric",
      tastyMetrics: {},
    });

    expect(fees).toMatchObject({
      route: "/fees",
      routeAlias: "fees",
      r: SEARCH_RANK.navPage,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
    });
    expect(revenue).toMatchObject({
      route: "/revenue",
      routeAlias: "revenue",
      r: SEARCH_RANK.navPage,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
    });
    expect(holdersRevenue).toMatchObject({
      route: "/holders-revenue",
      routeAlias: "holders revenue",
      r: SEARCH_RANK.navPage,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
    });
  });

  it("does not add route aliases to multi-segment pages", () => {
    expect(getFrontendPageRouteAlias("/fees/chains")).toBeUndefined();
    expect(getFrontendPageRouteAlias("/stablecoins/chains")).toBeUndefined();
  });

  it("keeps curated search keywords and scalar aliases", () => {
    const page = buildFrontendPageSearchResult({
      id: "metric_stablecoin-supply-by-chain",
      page: {
        name: "Stablecoin Supply by Chain",
        route: "/stablecoins/chains",
        searchKeywords: ["stablecoin chains", "stablecoins by chain", "stablecoin supply", "stablecoin", "stable"],
      },
      type: "Metric",
      tastyMetrics: {},
    });

    expect(page.keywords).toEqual([
      "stablecoin chains",
      "stablecoins by chain",
      "stablecoin supply",
      "stablecoin",
      "stable",
    ]);
    expect(page.alias1).toBe("stablecoin chains");
    expect(page.alias5).toBe("stable");
  });

  it("keeps route aliases when deduping frontend pages", () => {
    const stablecoins = buildFrontendPageSearchResult({
      id: "others_stablecoins",
      page: { name: "Stablecoins", route: "/stablecoins" },
      type: "Others",
      tastyMetrics: {},
    });
    delete stablecoins.routeAlias;

    const stablecoinsByMarketCap = buildFrontendPageSearchResult({
      id: "metric_stablecoins-by-market-cap",
      page: { name: "Stablecoins by Market Cap", route: "/stablecoins" },
      type: "Metric",
      tastyMetrics: {},
    });

    const [merged] = dedupeFrontendPageResults([stablecoins, stablecoinsByMarketCap]);

    expect(merged.routeAlias).toBe("stablecoins");
    expect(merged.name).toBe("Stablecoins");
    expect(merged.nameVariants).toContain("Stablecoins by Market Cap");
  });
});

describe("entity and subpage search docs", () => {
  it("skips zero-tvl canonical bridge rows that duplicate chain search results", () => {
    const chainNames = new Set(["Arbitrum", "Solana", "Zircuit"]);

    expect(
      shouldSkipProtocolSearchResult({ name: "Solana", category: "Canonical Bridge", tvl: null }, chainNames)
    ).toBe(true);
    expect(shouldSkipProtocolSearchResult({ name: "Arbitrum", category: "Canonical Bridge", tvl: 0 }, chainNames)).toBe(
      true
    );
    expect(
      shouldSkipProtocolSearchResult({ name: "Arbitrum Bridge", category: "Canonical Bridge", tvl: 100 }, chainNames)
    ).toBe(false);
    expect(
      shouldSkipProtocolSearchResult({ name: "Zircuit", category: "Canonical Bridge", tvl: 100 }, chainNames)
    ).toBe(false);
  });

  it("keeps protocol subpages below entities and without route aliases", () => {
    const result = buildProtocolSearchResult({
      id: "protocol_markit",
      name: "MarkIt",
      symbol: "MARKIT",
      tvl: 100,
      route: "/protocol/markit",
      v: 0,
    });
    const subPages = getProtocolSubSections({
      result,
      metadata: { name: "markit", fees: true, revenue: true },
      geckoId: null,
      tastyMetrics: {},
      protocolData: { name: "MarkIt" },
    });

    expect(subPages.find((page) => page.subName === "Fees")).toMatchObject({
      name: "MarkIt",
      route: "/protocol/markit?tvl=false&fees=true",
      r: SEARCH_RANK.subPage,
      topLevelRank: SEARCH_DEPTH_RANK.subPage,
    });
    expect(subPages.find((page) => page.subName === "Revenue")).toMatchObject({
      name: "MarkIt",
      route: "/protocol/markit?tvl=false&revenue=true",
      r: SEARCH_RANK.subPage,
      topLevelRank: SEARCH_DEPTH_RANK.subPage,
    });
    expect(subPages.some((page) => "routeAlias" in page)).toBe(false);
  });

  it("keeps exact protocol names and variants indexed", () => {
    const stabble = buildProtocolSearchResult({
      id: "protocol_parent_stabble",
      name: "Stabble",
      symbol: "STB",
      route: "/protocol/stabble",
      v: 0,
    });
    const markit = buildProtocolSearchResult({
      id: "protocol_markit",
      name: "MarkIt",
      route: "/protocol/markit",
      v: 0,
    });
    const stab = buildProtocolSearchResult({
      id: "protocol_stab-protocol",
      name: "STAB Protocol",
      symbol: "ILIS",
      route: "/protocol/stab-protocol",
      v: 0,
    });

    expect(stabble).toMatchObject({
      name: "Stabble",
      symbol: "STB",
      r: SEARCH_RANK.entity,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
    });
    expect(markit).toMatchObject({
      name: "MarkIt",
      route: "/protocol/markit",
      r: SEARCH_RANK.entity,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
    });
    expect(markit.nameVariants).toContain("Mark It");
    expect(stab).toMatchObject({
      name: "STAB Protocol",
      symbol: "ILIS",
      r: SEARCH_RANK.entity,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
    });
    expect(stab.routeAlias).toBeUndefined();
  });

  it("keeps stablecoin symbols indexed for USDT and USDC searches", () => {
    const tether = buildStablecoinSearchResult({ name: "Tether", symbol: "USDT", circulating: { peggedUSD: 100 } }, {});
    const usdCoin = buildStablecoinSearchResult(
      { name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 100 } },
      {}
    );

    expect(tether).toMatchObject({
      name: "Tether",
      symbol: "USDT",
      route: "/stablecoin/tether",
      r: SEARCH_RANK.entity,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
      type: "Stablecoin",
    });
    expect(usdCoin).toMatchObject({
      name: "USD Coin",
      symbol: "USDC",
      route: "/stablecoin/usd-coin",
      r: SEARCH_RANK.entity,
      topLevelRank: SEARCH_DEPTH_RANK.topLevel,
      type: "Stablecoin",
    });
  });
});

describe("directory search docs", () => {
  it("keeps curated external links without adding frontend page routes", () => {
    const results = buildDirectoryResults({ parentProtocols: [], protocols: [] }, {}, {});

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "others_llamafeed", name: "LlamaFeed", route: "https://llamafeed.io" }),
        expect.objectContaining({ id: "others_etherscan", name: "Etherscan", route: "https://etherscan.io/" }),
      ])
    );
    expect(results.some((result) => result.route?.startsWith("/"))).toBe(false);
  });

  it("builds external protocol URLs and dedupes shared parent and child websites", () => {
    const results = buildDirectoryResults(
      {
        parentProtocols: [
          {
            id: "parent#test",
            name: "Test Parent",
            symbol: "TEST",
            url: "https://example.com/",
          },
        ],
        protocols: [
          {
            name: "Test Child",
            symbol: "CHILD",
            tvl: 10,
            url: "https://example.com",
          },
        ],
      },
      { "parent#test": 100 },
      { "/protocol/test-parent": 5, "/protocol/test-child": 10 }
    );

    const match = results.find((result) => result.route === "https://example.com/");

    expect(match).toMatchObject({
      id: "directory_parent_test-parent",
      name: "Test Parent",
      route: "https://example.com/",
      r: SEARCH_RANK.entity,
      v: 5,
    });
    expect(results.some((result) => result.route?.startsWith("/"))).toBe(false);
    expect(results.filter((result) => result.route === "https://example.com/")).toHaveLength(1);
  });

  it("filters blank and placeholder directory URLs", () => {
    const results = buildDirectoryResults(
      {
        parentProtocols: [
          { id: "parent#blank", name: "Blank URL", url: "" },
          { id: "parent#dash", name: "Dash URL", url: "-" },
          { id: "parent#dash-space", name: "Dash Space URL", url: "- " },
        ],
        protocols: [
          { name: "Child Blank URL", tvl: 1, url: "" },
          { name: "Child Dash URL", tvl: 1, url: "-" },
          { name: "Child Dash Space URL", tvl: 1, url: "- " },
        ],
      },
      {},
      {}
    );

    expect(results.map((result) => result.name)).not.toEqual(
      expect.arrayContaining([
        "Blank URL",
        "Dash URL",
        "Dash Space URL",
        "Child Blank URL",
        "Child Dash URL",
        "Child Dash Space URL",
      ])
    );
  });
});
