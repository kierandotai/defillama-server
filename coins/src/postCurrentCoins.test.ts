import postCurrentCoinsHandler, { MAX_CURRENT_PRICE_COINS_PER_BATCH } from "./postCurrentCoins";
import { getCurrentCoins } from "./getCurrentCoins";

jest.mock("./getCurrentCoins", () => ({
  currentPricesExpiresHeaders: () => ({ Expires: "Wed, 20 May 2026 12:05:20 GMT" }),
  getCurrentCoins: jest.fn(),
}));

const getCurrentCoinsMock = getCurrentCoins as jest.MockedFunction<typeof getCurrentCoins>;

function parseResponse(raw: any) {
  return {
    ...raw,
    body: JSON.parse(raw.body),
  };
}

describe("postCurrentCoins", () => {
  beforeEach(() => {
    getCurrentCoinsMock.mockReset();
  });

  it("returns current prices with cache headers and search width", async () => {
    getCurrentCoinsMock.mockResolvedValue({
      "coingecko:ethereum": {
        price: 1,
        symbol: "ETH",
        timestamp: 1,
      },
    });

    const response = parseResponse(
      await postCurrentCoinsHandler({
        body: JSON.stringify({ coins: [" coingecko:ethereum "], searchWidth: "4h" }),
      } as any),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.Expires).toBe("Wed, 20 May 2026 12:05:20 GMT");
    expect(response.body).toEqual({
      coins: {
        "coingecko:ethereum": {
          price: 1,
          symbol: "ETH",
          timestamp: 1,
        },
      },
    });
    expect(getCurrentCoinsMock).toHaveBeenCalledWith({
      requestedCoins: ["coingecko:ethereum"],
      searchWidth: 4 * 60 * 60,
    });
  });

  it("rejects invalid coin arrays", async () => {
    const response = parseResponse(
      await postCurrentCoinsHandler({
        body: JSON.stringify({ coins: ["coingecko:ethereum", " "] }),
      } as any),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ message: "coins must be an array of non-empty strings" });
    expect(getCurrentCoinsMock).not.toHaveBeenCalled();
  });

  it("rejects empty coin arrays", async () => {
    const response = parseResponse(
      await postCurrentCoinsHandler({
        body: JSON.stringify({ coins: [] }),
      } as any),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ message: "coins must be an array of non-empty strings" });
    expect(getCurrentCoinsMock).not.toHaveBeenCalled();
  });

  it("rejects non-object request bodies", async () => {
    const response = parseResponse(
      await postCurrentCoinsHandler({
        body: "null",
      } as any),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ message: "Request body must be a JSON object" });
    expect(getCurrentCoinsMock).not.toHaveBeenCalled();
  });

  it("rejects malformed searchWidth values", async () => {
    const response = parseResponse(
      await postCurrentCoinsHandler({
        body: JSON.stringify({ coins: ["coingecko:ethereum"], searchWidth: "garbage" }),
      } as any),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ message: 'searchWidth must be a duration like "4h" or "12h"' });
    expect(getCurrentCoinsMock).not.toHaveBeenCalled();
  });

  it("rejects batches above the max coin cap", async () => {
    const response = parseResponse(
      await postCurrentCoinsHandler({
        body: JSON.stringify({
          coins: Array.from({ length: MAX_CURRENT_PRICE_COINS_PER_BATCH + 1 }, (_, i) => `coingecko:${i}`),
        }),
      } as any),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ message: `coins: max ${MAX_CURRENT_PRICE_COINS_PER_BATCH} per batch` });
    expect(getCurrentCoinsMock).not.toHaveBeenCalled();
  });
});
