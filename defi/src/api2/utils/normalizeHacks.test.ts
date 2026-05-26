import {
  cleanString,
  normalizeTechnique,
  normalizeChain,
  parseHackDate,
  normalizeAmount,
  TECHNIQUE_ALIASES,
} from "./normalizeHacks";

describe("cleanString", () => {
  it("trims surrounding whitespace", () => {
    expect(cleanString("  Reentrancy  ")).toBe("Reentrancy");
  });

  it("collapses internal whitespace runs", () => {
    expect(cleanString("Calculation  Error   In  Engine")).toBe("Calculation Error In Engine");
  });

  it("returns null for empty / whitespace-only strings", () => {
    expect(cleanString("")).toBeNull();
    expect(cleanString("   ")).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(cleanString(null)).toBeNull();
    expect(cleanString(undefined)).toBeNull();
    expect(cleanString(42)).toBeNull();
  });
});

describe("normalizeTechnique", () => {
  it("fixes the 'Acces Control Exploit' typo", () => {
    expect(normalizeTechnique("Acces Control Exploit")).toBe("Access Control Exploit");
  });

  it("trims whitespace", () => {
    expect(normalizeTechnique("Calculation Error in Liquidation Engine ")).toBe(
      "Calculation Error in Liquidation Engine"
    );
  });

  it("leaves canonical values untouched", () => {
    expect(normalizeTechnique("Reentrancy")).toBe("Reentrancy");
    expect(normalizeTechnique("Private Key Compromised (Unknown Method)")).toBe(
      "Private Key Compromised (Unknown Method)"
    );
  });

  it("returns null for missing values", () => {
    expect(normalizeTechnique(null)).toBeNull();
    expect(normalizeTechnique(undefined)).toBeNull();
  });

  it("does not silently unify judgment-call variants", () => {
    // These look similar but are not unified by the auto-normalizer; the
    // canonical decision should be made in Airtable by domain experts.
    expect(normalizeTechnique("Re-entrancy Exploit")).toBe("Re-entrancy Exploit");
    expect(normalizeTechnique("Flashloan Reentrancy Attack")).toBe(
      "Flashloan Reentrancy Attack"
    );
  });
});

describe("normalizeChain", () => {
  it("wraps single string into array", () => {
    expect(normalizeChain("Ethereum")).toEqual(["Ethereum"]);
  });

  it("trims and dedupes nothing but cleans entries", () => {
    expect(normalizeChain([" Ethereum ", "BSC"])).toEqual(["Ethereum", "BSC"]);
  });

  it("filters out empty entries", () => {
    expect(normalizeChain([" ", "Ethereum", ""])).toEqual(["Ethereum"]);
  });

  it("returns null for absent values", () => {
    expect(normalizeChain(null)).toBeNull();
    expect(normalizeChain(undefined)).toBeNull();
    expect(normalizeChain([])).toBeNull();
    expect(normalizeChain([" ", ""])).toBeNull();
  });
});

describe("parseHackDate", () => {
  it("parses ISO strings into seconds-since-epoch", () => {
    expect(parseHackDate("2023-03-13")).toBe(new Date("2023-03-13").getTime() / 1000);
  });

  it("returns null for missing / invalid input (previous impl produced NaN)", () => {
    expect(parseHackDate(undefined)).toBeNull();
    expect(parseHackDate(null)).toBeNull();
    expect(parseHackDate("")).toBeNull();
    expect(parseHackDate("not-a-date")).toBeNull();
  });
});

describe("normalizeAmount", () => {
  it("passes through finite non-negative numbers", () => {
    expect(normalizeAmount(0)).toBe(0);
    expect(normalizeAmount(1_400_000_000)).toBe(1_400_000_000);
  });

  it("rejects negatives, NaN, and non-numbers", () => {
    expect(normalizeAmount(-1)).toBeNull();
    expect(normalizeAmount(NaN)).toBeNull();
    expect(normalizeAmount(Infinity)).toBeNull();
    expect(normalizeAmount("100" as unknown)).toBeNull();
  });
});

describe("TECHNIQUE_ALIASES", () => {
  it("only contains zero-ambiguity fixes", () => {
    // If you add an alias here, it should be a typo or trivial variant of
    // its target, not a semantic judgment call. Update this test if the
    // policy ever changes.
    expect(Object.keys(TECHNIQUE_ALIASES)).toEqual(["Acces Control Exploit"]);
  });
});
