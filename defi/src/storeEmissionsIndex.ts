import { getR2, storeR2JSONString } from "./utils/r2";
import { fetchCurrentPrices, fetchMcaps } from "./utils/coinsApi";
import { sendMessage } from "./utils/discord";
import PromisePool from "@supercharge/promise-pool";
import { protocolsById } from "./protocols/data";
import parentProtocols from "./protocols/parentProtocols";
import { sluggifyString } from "./utils/sluggify";
import { buildHomepageUnlocksSummary, collectHomepageUnlockCoinIds } from "./homepage/unlocksSummary";

type ProtocolData = {
  token: string;
  tokenPrice?: any[];
  symbol?: string;
  sources: string[];
  protocolId?: string;
  protocolSlug?: string;
  name: string;
  circSupply: number;
  circSupply30d?: number;
  totalLocked: number;
  maxSupply: number;
  nextEvent?: {
    date: string;
    toUnlock: number;
    proportion?: number;
  };
  gecko_id?: string;
  mcap?: any;
  events?: any;
  unlockEvents?: any;
  unlocksPerDay: number;
};

type HomepagePriceMap = Record<string, { price?: number | null; symbol?: string | null }>;

const parentSlugById: Record<string, string> = {};
for (const pp of parentProtocols) {
  parentSlugById[pp.id] = sluggifyString(pp.name);
}

function getProtocolSlug(protocolId: string | null): string | undefined {
  if (!protocolId) return undefined;
  if (parentSlugById[protocolId]) return parentSlugById[protocolId];
  const p = protocolsById[protocolId];
  if (!p) return undefined;
  if (p.parentProtocol) return parentSlugById[p.parentProtocol] ?? sluggifyString(p.name);
  return sluggifyString(p.name);
}

const fetchProtocolData = async (protocols: string[]): Promise<ProtocolData[]> => {
  const protocolsData: ProtocolData[] = [];
  const now: number = Math.floor(Date.now() / 1000);

  async function fetchData(protocol: string) {
      let res: any;
      try {
        res = await getR2(`emissions/${protocol}`).then((res) => (res.body ? JSON.parse(res.body) : null));
      } catch {
        console.log(`${protocol} has no emissions in R2`);
        return;
      }
      if ((res.documentedData?.data ?? res.data) == null) return;

      const data: { [date: number]: number } = {};
      let previous: number = 0;
      try {
        (res.documentedData?.data ?? res.data).forEach(
          (item: { data: Array<{ timestamp: number; unlocked: number }> }) => {
            if (item.data == null) return;
            item.data.forEach((value, i) => {
              previous = Math.max(i > 0 ? item.data[i - 1].unlocked : 0, previous);
              data[value.timestamp] = (data[value.timestamp] || 0) + Math.max(value.unlocked, previous);
            });
          }
        );
      } catch {
        console.error(`${protocol} res parsing failed`);
        return;
      }

      const formattedData = Object.entries(data);
      if (!formattedData.length) {
        console.error(`${protocol} failed with 0 length data section`);
        return;
      }

      const maxSupply =
        res.metadata.total ??
        (res.documentedData?.data ?? res.data).reduce(
          (a: number, b: any) => (a += b.data[b.data.length - 1].unlocked),
          0
        );
      const rawNextEvent = res.metadata.events?.find((e: any) => e.timestamp > now);

      let nextEvent;
      if (!rawNextEvent) {
        nextEvent = undefined;
      } else if ((rawNextEvent.noOfTokens.length === 1)) {
        nextEvent = {
          date: rawNextEvent.timestamp,
          toUnlock: Math.max(rawNextEvent.noOfTokens[0], 0),
        };
      } else {
        nextEvent = {
          date: rawNextEvent.timestamp,
          toUnlock: Math.max(rawNextEvent.noOfTokens[1], 0),
        };
      }
      const nextUnlockIndex = formattedData.findIndex(([date]) => Number(date) > now);

      function getCircSupplyAtIndex(index: number): number {
        let supply: number = 0;
        (res.documentedData?.data ?? res.data).forEach(
          (item: { data: Array<{ timestamp: number; unlocked: number }> }) => {
            if (item.data == null) return;
            supply += item.data.at(index).unlocked;
          }
        );
        return supply;
      }

      const circSupply = getCircSupplyAtIndex(nextUnlockIndex);
      const timestamp30dAgo = now - (30 * 86400);
      const index30dAgo = formattedData.findIndex(([date]) => Number(date) > timestamp30dAgo);
      const circSupply30d = getCircSupplyAtIndex(index30dAgo);
      const unlocksPerDay = formattedData[nextUnlockIndex]?.[1] - formattedData[nextUnlockIndex - 1]?.[1];

      const protocolId = res.metadata.protocolIds?.[0] ?? null;
      protocolsData.push({
        token: res.metadata.token,
        sources: [],
        protocolId,
        protocolSlug: getProtocolSlug(protocolId),
        name: res.name,
        circSupply,
        circSupply30d,
        totalLocked: maxSupply - circSupply,
        maxSupply,
        gecko_id: res.gecko_id,
        events: res.metadata.events,
        unlockEvents: res.metadata.unlockEvents,
        nextEvent,
        unlocksPerDay,
      });
    }
  await PromisePool
    .withConcurrency(10)
    .for(protocols)
    .handleError(async (error, protocol) => {
      console.error(`Error processing ${protocol}: ${error}`);
    })
    .process(fetchData);

  return protocolsData;
};

const fetchCoinsApiData = async (protocols: ProtocolData[]): Promise<void> => {
  const step: number = 25;
  for (let i = 0; i < protocols.length; i = i + step) {
    const tokens: string = protocols
      .slice(i, Math.min(i + step, protocols.length))
      .reduce((p: string, c: ProtocolData) => `${p},${c.token}`, "")
      .slice(1);
    const coins: string[] = protocols
      .slice(i, Math.min(i + step, protocols.length))
      .filter((p: any) => p.gecko_id != null)
      .map((p: ProtocolData) => `coingecko:${p.gecko_id}`);

    const [tokenPrices, mcapRes] = await Promise.all([
      fetchCurrentPrices(tokens.split(",").filter(Boolean), {
        searchWidth: "4h",
        legacyApiKey: process.env.COINS_KEY,
      }),
      fetchMcaps(coins, { legacyApiKey: process.env.COINS_KEY }),
    ]);

    protocols.map((p: ProtocolData) => {
      if (p.token in tokenPrices.coins) {
        p.tokenPrice = [tokenPrices.coins[p.token]]; //tokenPrices.coins[p.token].price;
        // p.symbol = tokenPrices.coins[p.token].symbol;
      }
      if (p.gecko_id && `coingecko:${p.gecko_id}` in mcapRes) p.mcap = mcapRes[`coingecko:${p.gecko_id}`]?.mcap ?? 0;
    });
  }
};

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeCoinKey(idOrKey: string): string {
  return idOrKey.startsWith("coingecko:") ? idOrKey : `coingecko:${idOrKey}`;
}

function addTokenlistPrice({
  prices,
  requestedCoinIds,
  idOrKey,
  entry,
}: {
  prices: HomepagePriceMap;
  requestedCoinIds: Set<string>;
  idOrKey: string;
  entry: unknown;
}) {
  if (!entry || typeof entry !== "object") return;
  const coinKey = normalizeCoinKey(idOrKey);
  if (!requestedCoinIds.has(coinKey)) return;

  const price = (entry as { current_price?: unknown }).current_price;
  if (!isFinitePositiveNumber(price)) return;

  const symbol = (entry as { symbol?: unknown }).symbol;
  prices[coinKey] = {
    price,
    symbol: typeof symbol === "string" && symbol ? symbol.toUpperCase() : null,
  };
}

const fetchTokenlistHomepagePrices = async (coinIds: string[]): Promise<HomepagePriceMap> => {
  const requestedCoinIds = new Set(coinIds);
  const prices: HomepagePriceMap = {};
  const response = await getR2("tokenlist/sorted.json");
  const tokenlist = response.body ? JSON.parse(response.body) : null;

  if (Array.isArray(tokenlist)) {
    for (const entry of tokenlist) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string" || !id) continue;
      addTokenlistPrice({ prices, requestedCoinIds, idOrKey: id, entry });
    }
  } else if (tokenlist && typeof tokenlist === "object") {
    for (const [idOrKey, entry] of Object.entries(tokenlist)) {
      addTokenlistPrice({ prices, requestedCoinIds, idOrKey, entry });
    }
  }

  return prices;
};

const fetchHomepageUnlockPrices = async (protocols: ProtocolData[], nowSec: number) => {
  const coinIds = collectHomepageUnlockCoinIds({ protocols, nowSec });
  const prices = await fetchTokenlistHomepagePrices(coinIds).catch((error) => {
    console.error("Failed to fetch tokenlist prices for homepage unlocks summary", error);
    return {} as HomepagePriceMap;
  });
  const missingCoinIds = coinIds.filter((coinId) => !isFinitePositiveNumber(prices[coinId]?.price));
  const step = 1000;

  for (let i = 0; i < missingCoinIds.length; i += step) {
    const chunk = missingCoinIds.slice(i, i + step);
    const response = await fetchCurrentPrices(chunk, {
      searchWidth: "4h",
      legacyApiKey: process.env.COINS_KEY,
    });
    Object.assign(prices, response.coins);
  }

  return prices;
};

const fetchProtocolEmissionData = (protocol: ProtocolData) => {
  let price = protocol.tokenPrice ? protocol.tokenPrice[0] : undefined;
  if (price) price = price.price;

  const float = protocol.tokenPrice == null || isNaN(price) || protocol.mcap == 0 ? null : protocol.mcap / price;

  if (protocol.nextEvent && float) protocol.nextEvent.proportion = Math.max(protocol.nextEvent.toUnlock / float, 0);
};
export default async function handler(): Promise<void> {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const allProtocols = (await getR2(`emissionsProtocolsList`).then((res) => JSON.parse(res.body!))) as string[];
    const data: ProtocolData[] = await fetchProtocolData(allProtocols);
    try {
      const prices = await fetchHomepageUnlockPrices(data, nowSec);
      const summary = buildHomepageUnlocksSummary({ protocols: data, prices, nowSec });
      await storeR2JSONString("homepage/unlocks-summary.json", JSON.stringify(summary), 60 * 60);
    } catch (e) {
      try {
        await sendMessage(`Store homepage unlocks summary error: ${e}`, process.env.UNLOCKS_WEBHOOK!);
      } catch (notifyError) {
        console.error("Failed to notify homepage unlocks summary error", notifyError);
      }
    }
    await fetchCoinsApiData(data);
    data.forEach(fetchProtocolEmissionData)
    await storeR2JSONString("emissionsIndex", JSON.stringify({ data: data.sort((a, b) => b.mcap - a.mcap) }));
    console.log("done");
  } catch (e) {
    await sendMessage(`Store index error: ${e}`, process.env.UNLOCKS_WEBHOOK!);
  }
}
handler(); // ts-node src/storeEmissionsIndex.ts
