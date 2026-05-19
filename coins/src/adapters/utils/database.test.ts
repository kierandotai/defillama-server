jest.mock("../../utils/shared/dynamodb", () => ({
  batchGet: jest.fn(),
  batchWrite: jest.fn(),
}));

jest.mock("../../../../defi/src/utils/discord", () => ({
  sendMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@defillama/sdk", () => ({
  util: {
    sliceIntoChunks: (items: any[], size: number) => {
      const chunks = [];
      for (let i = 0; i < items.length; i += size)
        chunks.push(items.slice(i, i + size));
      return chunks;
    },
  },
  log: jest.fn(),
}));

import { staleMargin } from "../../utils/coingeckoPlatforms";
import { batchGet } from "../../utils/shared/dynamodb";
import { Write } from "./dbInterfaces";
import { filterWritesWithLowConfidence } from "./database";

const mockedBatchGet = batchGet as jest.MockedFunction<typeof batchGet>;

function now() {
  return Math.floor(Date.now() / 1000);
}

function write(PK: string, overrides: Partial<Write> = {}): Write {
  return {
    PK,
    SK: 0,
    price: 1,
    adapter: "test",
    confidence: 0.9,
    ...overrides,
  };
}

function read(PK: string, overrides: Record<string, any> = {}) {
  return {
    PK,
    SK: 0,
    price: 1,
    adapter: "test",
    confidence: 0.1,
    timestamp: now(),
    ...overrides,
  };
}

describe("filterWritesWithLowConfidence", () => {
  beforeEach(() => {
    mockedBatchGet.mockReset();
  });

  it("accepts lower-confidence writes when the stored asset price is stale", async () => {
    const assetPK = "asset#tempo:0xabc";
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, { confidence: 0.95, timestamp: now() - 3 * 60 * 60 - 1 }),
    ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { confidence: 0.4, price: 1.01 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });

  it("keeps the current higher-confidence read when the stored asset price is fresh", async () => {
    const assetPK = "asset#tempo:0xabc";
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, { confidence: 0.95, timestamp: now() }),
    ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { confidence: 0.4, price: 1.01 }),
    ]);

    expect(result).toEqual([]);
  });

  it("rewrites a high-confidence asset write onto a stale CoinGecko redirect", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now() - staleMargin - 1,
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.05, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(cgPK);
    expect(result[0].price).toBe(1.05);
  });

  it("drops redundant asset writes when the CoinGecko redirect is fresh", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now(),
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.01, confidence: 0.9 }),
    ]);

    expect(result).toEqual([]);
  });

  it("keeps the asset write when the CoinGecko redirect is missing", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.01, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });

  it("does not rewrite stale CoinGecko redirects when price movement is too large", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now() - staleMargin - 1,
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.2, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });
});
