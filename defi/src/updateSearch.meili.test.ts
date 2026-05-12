import fetch from "node-fetch";
import dotenv from "dotenv";
import { PAGES_INDEX_SETTINGS, SEARCH_DEPTH_RANK } from "./updateSearch";

if (process.env.APP_ENV) dotenv.config({ path: process.env.APP_ENV, override: false });

const shouldRun = process.env.RUN_SEARCH_MEILI_TESTS === "1";
const describeSearch = shouldRun ? describe : describe.skip;
const host = process.env.SEARCH_TEST_MEILI_HOST ?? "http://127.0.0.1:7700";
const key = process.env.SEARCH_TEST_MEILI_KEY ?? "masterKey";
const prodHost = process.env.SEARCH_PROD_MEILI_HOST ?? "https://search-core.defillama.com";
const index = `test_pages_${Date.now()}_${Math.random().toString(36).slice(2)}`;

if (shouldRun) jest.setTimeout(300_000);

interface SearchHit {
  id: string;
  name: string;
  route: string;
  subName?: string;
  type?: string;
  topLevelRank?: number;
}

interface SearchCase {
  query: string;
  firstRoute?: string;
  blockedSubNames?: string[];
  routesWithinRank?: Array<{ route: string; maxRank: number }>;
  routesBeforeRoutes?: Array<{ beforeRoute: string; afterRoute: string }>;
}

const SEARCH_CASES: SearchCase[] = [
  { query: "fees", firstRoute: "/fees", blockedSubNames: ["Fees"] },
  { query: "revenue", firstRoute: "/revenue", blockedSubNames: ["Revenue"] },
  { query: "holders-revenue", firstRoute: "/holders-revenue", blockedSubNames: ["Holders Revenue"] },
  { query: "mcap", blockedSubNames: ["Mcap"] },
  { query: "tvl", blockedSubNames: ["TVL"] },
  {
    query: "aave",
    firstRoute: "/protocol/aave",
    routesWithinRank: [{ route: "/protocol/aave?tvl=false&fees=true", maxRank: 25 }],
  },
  { query: "stabble", firstRoute: "/protocol/stabble" },
  {
    query: "stab",
    firstRoute: "/protocol/stab-protocol",
    routesWithinRank: [{ route: "/stablecoins", maxRank: 3 }],
    routesBeforeRoutes: [{ beforeRoute: "/stablecoins", afterRoute: "/protocol/stab-protocol?tvl=true" }],
  },
  { query: "markit", firstRoute: "/protocol/markit" },
  { query: "cap", firstRoute: "/protocol/cap", routesWithinRank: [{ route: "/token/CAP", maxRank: 15 }] },
  {
    query: "usdt",
    firstRoute: "/stablecoin/tether",
    routesWithinRank: [
      { route: "/stablecoin/tether", maxRank: 5 },
      { route: "/token/USDT", maxRank: 10 },
    ],
  },
  { query: "usdc", firstRoute: "/stablecoin/usd-coin", routesWithinRank: [{ route: "/token/USDC", maxRank: 10 }] },
  { query: "eth", routesWithinRank: [{ route: "/token/ETH", maxRank: 5 }] },
  { query: "sol", routesWithinRank: [{ route: "/token/SOL", maxRank: 5 }] },
  { query: "mega", routesWithinRank: [{ route: "/token/MEGA", maxRank: 2 }] },
];

async function meiliRequest(baseUrl: string, bearerToken: string | undefined, path: string, options: any = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function meili(path: string, options: any = {}) {
  return meiliRequest(host, key, path, options);
}

async function prodMeili(path: string, options: any = {}) {
  return meiliRequest(prodHost, process.env.SEARCH_MASTER_KEY, path, options);
}

async function waitTask(taskUid: number) {
  for (let i = 0; i < 180; i++) {
    const task = await meili(`/tasks/${taskUid}`);
    if (["succeeded", "failed", "canceled"].includes(task.status)) {
      if (task.status !== "succeeded") throw new Error(JSON.stringify(task, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Meili task ${taskUid} timed out`);
}

async function putSetting(setting: string, value: unknown) {
  const task = await meili(`/indexes/${index}/settings/${setting}`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
  await waitTask(task.taskUid);
}

async function search(q: string): Promise<SearchHit[]> {
  const res = await meili("/multi-search", {
    method: "POST",
    body: JSON.stringify({ queries: [{ indexUid: index, q, limit: 50, offset: 0 }] }),
  });
  return res?.results?.[0]?.hits ?? [];
}

async function getProdPagesDocuments() {
  const results: SearchHit[] = [];
  const limit = 100_000;
  let offset = 0;

  while (true) {
    const res = await prodMeili(`/indexes/pages/documents?limit=${limit}&offset=${offset}`);
    results.push(...res.results);
    if (res.results.length < limit || results.length >= res.total) return results;
    offset += limit;
  }
}

async function getSearchDocuments() {
  if (!process.env.SEARCH_MASTER_KEY) {
    throw new Error("Set SEARCH_MASTER_KEY or APP_ENV pointing to an env file before running search tests");
  }
  const results = await getProdPagesDocuments();
  return results.map((result) => ({
    ...result,
    topLevelRank: result.topLevelRank ?? (result.subName ? SEARCH_DEPTH_RANK.subPage : SEARCH_DEPTH_RANK.topLevel),
  }));
}

describeSearch("search results in Meilisearch", () => {
  beforeAll(async () => {
    const results = await getSearchDocuments();
    const createIndex = await meili("/indexes", {
      method: "POST",
      body: JSON.stringify({ uid: index, primaryKey: "id" }),
    });
    await waitTask(createIndex.taskUid);

    await putSetting("searchable-attributes", PAGES_INDEX_SETTINGS.searchableAttributes);
    await putSetting("ranking-rules", PAGES_INDEX_SETTINGS.rankingRules);
    await putSetting("filterable-attributes", PAGES_INDEX_SETTINGS.filterableAttributes);
    await putSetting("sortable-attributes", PAGES_INDEX_SETTINGS.sortableAttributes);
    await putSetting("displayed-attributes", PAGES_INDEX_SETTINGS.displayedAttributes);
    await putSetting("synonyms", PAGES_INDEX_SETTINGS.synonyms);

    const addDocs = await meili(`/indexes/${index}/documents`, {
      method: "POST",
      body: JSON.stringify(results),
    });
    await waitTask(addDocs.taskUid);
  });

  afterAll(async () => {
    if (!shouldRun) return;
    try {
      const task = await meili(`/indexes/${index}`, { method: "DELETE" });
      await waitTask(task.taskUid);
    } catch (e) {
      console.error(e);
    }
  });

  test.each(SEARCH_CASES)(
    "$query",
    async ({ query, firstRoute, blockedSubNames, routesWithinRank, routesBeforeRoutes }) => {
      const hits = await search(query);

      if (firstRoute) expect(hits[0]?.route).toBe(firstRoute);

      for (const subName of blockedSubNames ?? []) {
        const subpageHit = hits.find((hit) => hit.subName === subName);
        expect(subpageHit).toBeUndefined();
      }

      for (const expected of routesWithinRank ?? []) {
        const rank = hits.findIndex((hit) => hit.route === expected.route) + 1;
        expect(rank).toBeGreaterThan(0);
        expect(rank).toBeLessThanOrEqual(expected.maxRank);
      }

      for (const expected of routesBeforeRoutes ?? []) {
        const beforeRank = hits.findIndex((hit) => hit.route === expected.beforeRoute) + 1;
        const afterRank = hits.findIndex((hit) => hit.route === expected.afterRoute) + 1;
        expect(beforeRank).toBeGreaterThan(0);
        if (afterRank > 0) expect(beforeRank).toBeLessThan(afterRank);
      }
    }
  );
});
