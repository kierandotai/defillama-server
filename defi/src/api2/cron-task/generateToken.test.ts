import { getTokenExtras, getTokenRightsSymbols, reassignSymbolKeysByRank } from "./generateToken";

describe("generateToken token rights flags", () => {
  it("marks token-rights rows by token symbol when protocol metadata is missing", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP", "sBP"] }]);

    expect(getTokenExtras({ symbol: "BP", token_nk: "coingecko:backpack" }, new Map(), tokenRightsSymbols)).toEqual({
      tokenRights: true,
    });
  });

  it("does not mark tokens whose symbol is missing from token-rights rows", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);

    expect(
      getTokenExtras(
        { symbol: "BPT", token_nk: "coingecko:balancer-pool-token" },
        new Map([["balancer-pool-token", { protocolId: "balancer" }]]),
        tokenRightsSymbols
      )
    ).toEqual({ protocolId: "balancer" });
  });

  it("returns existing tokenRights extras without overwriting", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);
    const extras = { tokenRights: true };

    expect(
      getTokenExtras(
        { symbol: "BP", token_nk: "coingecko:backpack" },
        new Map([["backpack", extras]]),
        tokenRightsSymbols
      )
    ).toBe(extras);
  });

  it("merges tokenRights with existing protocol and chain metadata", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);

    expect(
      getTokenExtras(
        { symbol: "BP", token_nk: "coingecko:backpack" },
        new Map([["backpack", { protocolId: "4266", chainId: "backpack" }]]),
        tokenRightsSymbols
      )
    ).toEqual({ protocolId: "4266", chainId: "backpack", tokenRights: true });
  });

  it("returns extras when symbol is missing", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);

    expect(getTokenExtras({ token_nk: "coingecko:backpack" }, new Map(), tokenRightsSymbols)).toEqual({});
  });
});

describe("reassignSymbolKeysByRank", () => {
  it("moves the symbol slug to the entry with the best (lowest) mcap_rank", () => {
    const bySlug: Record<string, any> = {
      mega: {
        name: "Megaton Finance",
        symbol: "MEGA",
        token_nk: "coingecko:megaton-finance",
        route: "/token/MEGA",
        mcap_rank: 4599,
      },
      megaeth: {
        name: "MegaETH",
        symbol: "MEGA",
        token_nk: "coingecko:megaeth",
        route: "/token/MegaETH",
        mcap_rank: 262,
      },
    };

    const reassigned = reassignSymbolKeysByRank(bySlug);

    expect(reassigned).toBe(1);
    expect(bySlug.mega.token_nk).toBe("coingecko:megaeth");
    expect(bySlug.mega.route).toBe("/token/MEGA");
    expect(bySlug.megaeth).toBeUndefined();
    expect(bySlug["megaton-finance"].token_nk).toBe("coingecko:megaton-finance");
    expect(bySlug["megaton-finance"].route).toBe("/token/Megaton%20Finance");
  });

  it("does nothing when the best-ranked entry already holds the symbol slug", () => {
    const bySlug: Record<string, any> = {
      mega: {
        name: "MegaETH",
        symbol: "MEGA",
        token_nk: "coingecko:megaeth",
        route: "/token/MEGA",
        mcap_rank: 262,
      },
      "megaton-finance": {
        name: "Megaton Finance",
        symbol: "MEGA",
        token_nk: "coingecko:megaton-finance",
        route: "/token/Megaton%20Finance",
        mcap_rank: 4599,
      },
    };

    const reassigned = reassignSymbolKeysByRank(bySlug);

    expect(reassigned).toBe(0);
    expect(bySlug.mega.token_nk).toBe("coingecko:megaeth");
    expect(bySlug["megaton-finance"].token_nk).toBe("coingecko:megaton-finance");
  });

  it("treats missing or non-finite mcap_rank as worst rank", () => {
    const bySlug: Record<string, any> = {
      foo: {
        name: "Foo Coin",
        symbol: "FOO",
        token_nk: "coingecko:foo-low",
        route: "/token/FOO",
      },
      "foo-pro": {
        name: "Foo Pro",
        symbol: "FOO",
        token_nk: "coingecko:foo-pro",
        route: "/token/Foo%20Pro",
        mcap_rank: 100,
      },
    };

    const reassigned = reassignSymbolKeysByRank(bySlug);

    expect(reassigned).toBe(1);
    expect(bySlug.foo.token_nk).toBe("coingecko:foo-pro");
    expect(bySlug.foo.route).toBe("/token/FOO");
    expect(bySlug["foo-coin"].token_nk).toBe("coingecko:foo-low");
    expect(bySlug["foo-coin"].route).toBe("/token/Foo%20Coin");
    expect(bySlug["foo-pro"]).toBeUndefined();
  });

  it("assigns the symbol slug to the best-ranked entry when no entry currently holds it", () => {
    const bySlug: Record<string, any> = {
      "bar-old": {
        name: "Bar Old",
        symbol: "BAR",
        token_nk: "coingecko:bar-old",
        route: "/token/Bar%20Old",
        mcap_rank: 9000,
      },
      "bar-new": {
        name: "Bar New",
        symbol: "BAR",
        token_nk: "coingecko:bar-new",
        route: "/token/Bar%20New",
        mcap_rank: 50,
      },
    };

    const reassigned = reassignSymbolKeysByRank(bySlug);

    expect(reassigned).toBe(1);
    expect(bySlug.bar.token_nk).toBe("coingecko:bar-new");
    expect(bySlug.bar.route).toBe("/token/BAR");
    expect(bySlug["bar-new"]).toBeUndefined();
    expect(bySlug["bar-old"].token_nk).toBe("coingecko:bar-old");
  });

  it("leaves singletons untouched", () => {
    const bySlug: Record<string, any> = {
      btc: {
        name: "Bitcoin",
        symbol: "BTC",
        token_nk: "coingecko:bitcoin",
        route: "/token/BTC",
        mcap_rank: 1,
      },
    };

    const reassigned = reassignSymbolKeysByRank(bySlug);

    expect(reassigned).toBe(0);
    expect(bySlug.btc.token_nk).toBe("coingecko:bitcoin");
  });
});
