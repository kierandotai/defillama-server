
import * as sdk from '@defillama/sdk'
import { getApi } from "../utils/sdk";
import { getCurrentUnixTimestamp } from "../../utils/date";
import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import { getTokenInfoMap } from "../utils/erc20";
const { request } = sdk.graph
import { getConfig } from "../../utils/cache";
import getWrites from "../utils/getWrites";
import { getTokenAndRedirectDataMap } from "../utils/database";

type VaultDatas = {
  [vault: string]: {
    totalAssets: number;
    positions: any[];
    markets: string[];
  };
};

const listaConfig: { [chain: string]: { vault: string; vaultInfo: string } } = {
  bsc: {
    vault: "0x8F73b65B4caAf64FBA2aF91cC5D4a2A1318E5D8C",
    vaultInfo:
      "https://api.lista.org/api/moolah/vault/list?page=1&pageSize=1000",
  },
  ethereum: {
    vault: "0xf820fB4680712CD7263a0D3D024D5b5aEA82Fd70",
    vaultInfo:
      "https://api.lista.org/api/moolah/vault/list?page=1&pageSize=1000&chain=ethereum",
  },
};

async function fetchMorphoVaultAddresses(chainId: string) {
  async function getCachedV1Vaults() {
    return await sdk.cache.cachedFetch({
      key: `morpho-vaults-${chainId}-v1`,
      fetcher: async () => {
        let assets: { [vault: string]: string } = {};
        let skip = 0;
        let length = 1000;

        while (length == 1000) {
          const query = `
        query {
            vaults (first: ${length}, skip: ${skip}, orderBy: Address, where:  {
                chainId_in: [${chainId}]
            }) {
                items {
                    asset {
                        address
                    }
                    address
                }
            }}`;

          const res = await request("https://api.morpho.org/graphql", query);
          res.vaults.items.forEach((item: any) => {
            assets[item.address.toLowerCase()] = item.asset.address.toLowerCase();
          });
          length = res.vaults.items.length;
          skip += length;
        }
        return assets;
      }
    });
  }

  async function getCachedV2Vaults() {
    return await sdk.cache.cachedFetch({
      key: `morpho-vaults-${chainId}-v2-full`,
      fetcher: async () => {
        const out: { [vault: string]: V2VaultInfo } = {};
        let skip = 0;
        const first = 1000;
        let length = first;

        while (length == first) {
          const url = `https://app.morpho.org/api/vaults?first=${first}&skip=${skip}&orderBy=totalAssetsUsd&orderDirection=DESC&chainIds=${chainId}&version=2.0&faceting=true`;
          const res = await getConfig(`morpho-vaults-${chainId}-v2-${skip}`, url);
          const items = res?.items ?? res?.vaults?.items ?? [];
          items.forEach((item: any) => {
            const vault = item.address?.toLowerCase();
            const asset = (item.asset?.address ?? item.asset)?.toLowerCase?.();
            if (!vault || !asset) return;
            out[vault] = {
              asset,
              name: item.name ?? "",
              totalAssets: Number(item.totalAssets ?? 0),
              liquidity: Number(item.liquidity ?? 0),
              forceDeallocatableLiquidity: Number(item.forceDeallocatableLiquidity ?? 0),
            };
          });
          length = items.length;
          skip += length;
        }
        return out;
      }
    });
  }

  const [v1, v2] = await Promise.all([getCachedV1Vaults(), getCachedV2Vaults()]);
  const v1Lc: { [k: string]: string } = Object.fromEntries(
    Object.entries(v1 as { [k: string]: string }).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]),
  );
  return { v1: v1Lc, v2: v2 as { [vault: string]: V2VaultInfo } };
}

type V2VaultInfo = {
  asset: string;
  name: string;
  totalAssets: number;
  liquidity: number;
  forceDeallocatableLiquidity: number;
};

async function morpho(
  timestamp: number = 0,
  vaultAssets: { [vault: string]: string } = {},
  api: any,
  target: string,
  nameMap: { [vault: string]: string } = {},
) {
  const threeDaysAgo =
    (timestamp == 0 ? getCurrentUnixTimestamp() : timestamp) - 3 * 24 * 60 * 60;
  const threeDaysAgoApi = await getApi(api.chain, threeDaysAgo);

  if (!api.chainId) throw new Error("Chain ID not found");
  const allMarkets: string[] = [];
  const vaults = Object.keys(vaultAssets);

  const [currentVaultDatas, previousVaultDatas] = await Promise.all([
    fetchAllVaultPositions(api),
    fetchAllVaultPositions(threeDaysAgoApi),
  ]);

  async function fetchAllVaultPositions(api: any): Promise<VaultDatas> {
    const [totalAssetsArr, withdrawQueueLengths] = await Promise.all([
      api.multiCall({
        abi: "uint256:totalAssets",
        calls: vaults,
        permitFailure: true,
      }),
      api.multiCall({
        abi: "uint256:withdrawQueueLength",
        calls: vaults,
        permitFailure: true,
      }),
    ]);

    // Flatten (vault, index) pairs for a single withdrawQueue multicall
    const queueCalls: { target: string; params: number; vaultIdx: number }[] = [];
    vaults.forEach((vault, vIdx) => {
      const len = Number(withdrawQueueLengths[vIdx] ?? 0);
      for (let i = 0; i < len; i++) {
        queueCalls.push({ target: vault, params: i, vaultIdx: vIdx });
      }
    });

    const queueResults = await api.multiCall({
      abi: "function withdrawQueue(uint256 index) view returns (bytes32)",
      calls: queueCalls.map(({ target, params }) => ({ target, params })),
      permitFailure: true,
    });

    const marketsByVault: string[][] = vaults.map(() => []);
    queueResults.forEach((market: string, i: number) => {
      if (!market) return;
      marketsByVault[queueCalls[i].vaultIdx].push(market);
    });

    // Flatten (vault, market) pairs for a single position multicall
    const positionCalls: { params: [string, string]; vaultIdx: number }[] = [];
    vaults.forEach((vault, vIdx) => {
      marketsByVault[vIdx].forEach((market) => {
        positionCalls.push({ params: [market, vault], vaultIdx: vIdx });
      });
    });

    const positionResults = await api.multiCall({
      target,
      abi: "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
      calls: positionCalls.map(({ params }) => ({ params })),
      permitFailure: true,
    });

    const positionsByVault: any[][] = vaults.map(() => []);
    positionResults.forEach((pos: any, i: number) => {
      positionsByVault[positionCalls[i].vaultIdx].push(pos);
    });

    const datas: VaultDatas = {};
    vaults.forEach((vault, vIdx) => {
      const markets = marketsByVault[vIdx];
      allMarkets.push(...markets);
      datas[vault] = {
        totalAssets: totalAssetsArr[vIdx],
        positions: positionsByVault[vIdx],
        markets,
      };
    });
    return datas;
  }

  const uniqueMarkets = [...new Set(allMarkets)];
  const [currentMarketData, previousMarketData] = await Promise.all([
    fetchMarketData(api),
    fetchMarketData(threeDaysAgoApi),
  ]);

  async function fetchMarketData(api: any) {
    const marketDataArray = await api.multiCall({
      target,
      abi: "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
      calls: uniqueMarkets.map((market: string) => ({ params: market })),
      permitFailure: true,
    });
    const marketData: {
      [market: string]: {
        totalSupplyAssets: number;
        totalSupplyShares: number;
        totalBorrowAssets: number;
      };
    } = {};
    marketDataArray.forEach((m: any, i: number) => {
      marketData[uniqueMarkets[i]] = m;
    });

    return marketData;
  }

  const currentTotalWithdrawables = aggregateWithdrawable(
    currentVaultDatas,
    currentMarketData,
  );
  const previousTotalWithdrawables = aggregateWithdrawable(
    previousVaultDatas,
    previousMarketData,
  );

  function aggregateWithdrawable(vaultDatas: VaultDatas, marketData: any) {
    let totalWithdrawables: { [vault: string]: number } = {};
    Object.keys(vaultDatas).map((vault: string) => {
      totalWithdrawables[vault] = 0;
      const { positions, markets } = vaultDatas[vault];

      markets.map((market: string, i: number) => {
        if (!marketData[market] || !positions[i]) return;
        const { totalSupplyAssets, totalSupplyShares, totalBorrowAssets } =
          marketData[market];
        if (positions[i].supplyShares == 0) return;
        const supplyAssets =
          (positions[i].supplyShares * totalSupplyAssets) / totalSupplyShares;

        const availableLiquidity = Math.max(
          totalSupplyAssets - totalBorrowAssets,
          0,
        );

        const withdrawable = Math.min(supplyAssets, availableLiquidity);

        totalWithdrawables[vault] += Number(withdrawable);
      });
    });

    return totalWithdrawables;
  }

  const problemVaultList: string[] = [];
  const problemVaultMetadata: any = []
  Object.keys(currentVaultDatas).map((vault: string) => {
    const { totalAssets } = currentVaultDatas[vault];
    if (totalAssets == 0) return;

    const currentWithdrawable = currentTotalWithdrawables[vault];
    const previousWithdrawable = previousTotalWithdrawables[vault];
    if (currentWithdrawable / totalAssets > 0.01) return;

    if (!previousVaultDatas[vault]) {
      if (currentWithdrawable / totalAssets < 0.01)
        problemVaultMetadata.push({ chain: api.chain, currentWithdrawable, name: nameMap[vault] ?? "-",  vault, totalAssets,  });
        console.log(
          `Bad debt in vault ${vault} (${nameMap[vault]}) on ${api.chain}: ${(
            (currentWithdrawable / totalAssets) *
            100
          ).toFixed(2)}% liquidity`,
        );

      problemVaultList.push(vault);
      return;
    }

    const { totalAssets: previousTotalAssets } = previousVaultDatas[vault];
    if (
      previousWithdrawable &&
      previousWithdrawable / previousTotalAssets > 0.01
    )
      return;

    problemVaultList.push(vault);
    problemVaultMetadata.push({ chain: api.chain, currentWithdrawable, name: nameMap[vault] ?? "-",  vault, totalAssets,  liquidity: (
        (currentWithdrawable / totalAssets) *
        100
      ).toFixed(2)});
  });

  if (problemVaultList.length > 0)
    sdk.logTable(problemVaultMetadata)

  const metadata = await getTokenInfoMap(api.chain, problemVaultList);

  const writes: Write[] = [];
  problemVaultList.forEach(async (vault: string) => {
    const { symbol, decimals } = metadata[vault];
    if (!symbol || !decimals) return;
    addToDBWritesList(
      writes,
      api.chain,
      vault,
      0,
      decimals,
      symbol,
      timestamp,
      "morpho",
      1.01,
    );
  });

  return writes;
}

async function detectV2BadDebt(
  v2Vaults: { [vault: string]: V2VaultInfo },
  chain: string,
): Promise<string[]> {
  const problemVaults: string[] = [];
  Object.entries(v2Vaults).forEach(([vault, info]) => {
    const { totalAssets, liquidity, forceDeallocatableLiquidity, name } = info;
    if (totalAssets === 0) return;
    const withdrawable = liquidity + forceDeallocatableLiquidity;
    const ratio = withdrawable / totalAssets;
    if (ratio > 0.01) return;
    console.log(
      `Bad debt in V2 vault ${vault} (${name}) on ${chain}: ${(ratio * 100).toFixed(2)}% liquidity`,
    );
    problemVaults.push(vault);
  });
  return problemVaults;
}

async function getListaVaults(chain: string) {
  const {
    data: { list: vaults },
  } = await getConfig("lista-lend-vaults", listaConfig[chain].vaultInfo);
  const listaVaults: { [vault: string]: string } = {};
  vaults.map(
    (vault: any) =>
      (listaVaults[vault.address.toLowerCase()] = vault.asset.toLowerCase()),
  );
  return listaVaults;
}

async function lista(timestamp: number = 0) {
  return await Promise.all(
    Object.keys(listaConfig).map(async (chain) => {
      const api = await getApi(chain, timestamp);
      const vaults = await getListaVaults(chain);
      return await morpho(timestamp, vaults, api, listaConfig[chain].vault);
    }),
  );
}

export async function morphoBlue(timestamp: number = 0) {
  const writes: Write[] = [];
  // Morpho Blue uses the canonical 0xBBBB... address on most chains, but a few
  // chains were deployed with bespoke addresses. Using the wrong target makes
  // every position()/market() call fail and falsely flags every vault as bad debt.
  const morphoBlueTargets: { [chainId: string]: string } = {
    ethereum: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    base: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    arbitrum: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    fraxtal: "0xa6030627d724bA78a59aCf43Be7550b4C5a0653b",
    ink: "0x857f3EefE8cbda3Bc49367C996cd664A880d3042",
    optimism: "0xce95AfbB8EA029495c66020883F87aaE8864AF92",
    polygon: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67",
    scroll: "0x2d012EdbAdc37eDc2BC62791B666f9193FDF5a55",
    wc: "0xE741BC7c34758b4caE05062794E8Ae24978AF432",
    mode: "0xd85cE6BD68487E0AaFb0858FDE1Cd18c76840564",
    corn: "0xc2B1E031540e3F3271C5F3819F0cC7479a8DdD90",
    hemi: "0xa4Ca2c2e25b97DA19879201bA49422bc6f181f42",
    sonic: "0xd6c916eB7542D0Ad3f18AEd0FCBD50C582cfa95f",
    unichain: "0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A",
    hyperliquid: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
    plume_mainnet: "0x42b18785CE0Aed7BF7Ca43a39471ED4C0A3e0bB5",
    lisk: "0x00cD58DEEbd7A2F1C55dAec715faF8aed5b27BF8",
    soneium: "0xE75Fc5eA6e74B824954349Ca351eb4e671ADA53a",
    katana: "0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc",
    tac: "0x918B9F2E4B44E20c6423105BB6cCEB71473aD35c",
    zircuit: "0xA902A365Fe10B4a94339B5A2Dc64F60c1486a5c8",
    abstract: "0xc85CE8ffdA27b646D269516B8d0Fa6ec2E958B55",
    btr: "0xaea7eff1bd3c875c18ef50f0387892df181431c6",
    bsc: "0x01b0Bd309AA75547f7a37Ad7B1219A898E67a83a",
    etlk: "0xbCE7364E63C3B13C73E9977a83c9704E2aCa876e",
    xdai: "0xB74D4dd451E250bC325AFF0556D717e4E2351c66",
    sei: "0xc9cDAc20FCeAAF616f7EB0bb6Cd2c69dcfa9094c",
    btnx: "0x8183d41556Be257fc7aAa4A48396168C8eF2bEAD",
    monad: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee",
    stable: "0xa40103088A899514E3fe474cD3cc5bf811b1102e",
    linea: "0x6B0D716aC0A45536172308e08fC2C40387262c9F",
    flare: "0xF4346F5132e810f80a28487a79c7559d9797E8B0",
    citrea: "0x99D31FEcc885204b4136ea5D2ef2a37F36E3AeB8",
    celo: "0xd24ECdD8C1e0E57a4E26B1a7bbeAa3e95466A569",
    tempo: "0x10EE9AAC980A180dd4DcFc96C746d60B0EA88f97",
  }

  const chains = Object.keys(morphoBlueTargets)

  await Promise.all(
    chains.map(async (chain) => {
      const api = await getApi(chain, timestamp);
      if (!api.chainId) return;
      const morphoBlueTarget = morphoBlueTargets[chain];
      if (!morphoBlueTarget) {
        console.log(`morpho: no Morpho Blue address configured for chain ${chain} (${api.chainId})`);
        return;
      }
      const { v1: v1Vaults, v2: v2Vaults } = await fetchMorphoVaultAddresses(
        api.chainId.toString(),
      );
      const v2AssetMap: { [vault: string]: string } = Object.fromEntries(
        Object.entries(v2Vaults).map(([vault, info]) => [vault, info.asset]),
      );
      const vaultAssets = { ...v1Vaults, ...v2AssetMap };
      const vaults = Object.keys(vaultAssets);
      if (vaults.length === 0) return;

      // Price all vault tokens via ERC4626 exchange rate
      const underlyings = vaults.map((v) => vaultAssets[v]);
      const [totalAssets, totalSupply, vaultDecimals, underlyingDecimals, vaultNames] =
        await Promise.all([
          api.multiCall({ abi: "uint256:totalAssets", calls: vaults, permitFailure: true, }),
          api.multiCall({ abi: "uint256:totalSupply", calls: vaults, permitFailure: true, }),
          api.multiCall({ abi: "uint8:decimals", calls: vaults, permitFailure: true, }),
          api.multiCall({ abi: "uint8:decimals", calls: underlyings, permitFailure: true, }),
          api.multiCall({ abi: "string:name", calls: vaults, permitFailure: true, }),
        ]);
      const nameMap: { [vault: string]: string } = {};
      vaults.forEach((vault, i) => {
        nameMap[vault] = vaultNames[i] ?? "";
      });

      const pricesObject: {
        [vault: string]: { underlying: string; price: number };
      } = {};
      vaults.forEach((vault, i) => {
        if (!totalAssets[i] || !totalSupply[i]) return;
        if (vaultDecimals[i] == null || underlyingDecimals[i] == null) return;
        const supply = Number(totalSupply[i]);
        if (supply === 0) return;
        const decimalAdjustment = 10 ** (vaultDecimals[i] - underlyingDecimals[i]);
        const price = (Number(totalAssets[i]) / supply) * decimalAdjustment;
        if (price < 0.5 || price > 100) return;
        pricesObject[vault] = {
          underlying: vaultAssets[vault],
          price,
        };
      });

      // Filter out pools with < $10k TVL
      const uniqueUnderlyings = [...new Set(Object.values(pricesObject).map((v) => v.underlying))];
      const underlyingPrices = await getTokenAndRedirectDataMap(uniqueUnderlyings, chain, timestamp);
      const filteredPricesObject: typeof pricesObject = {};
      vaults.forEach((vault, i) => {
        if (!pricesObject[vault]) return;
        const underlyingPrice = underlyingPrices[pricesObject[vault].underlying]?.price;
        if (!underlyingPrice) return;
        const tvl = (Number(totalAssets[i]) / 10 ** (underlyingDecimals[i] ?? 0)) * underlyingPrice;
        if (tvl < 10_000) return;
        filteredPricesObject[vault] = pricesObject[vault];
      });

      const chainWrites = await getWrites({
        chain,
        timestamp,
        pricesObject: filteredPricesObject,
        projectName: "morpho",
        confidence: 0.85
      });
      writes.push(...chainWrites);

      // Override bad debt vaults with price=0 (confidence 1.01 beats normal writes)
      // V1 (MetaMorpho) bad-debt detection uses withdrawQueue + market state on-chain.
      const badDebtWrites = await morpho(
        timestamp,
        v1Vaults,
        api,
        morphoBlueTarget,
        nameMap,
      );
      writes.push(...badDebtWrites);

      // V2 bad-debt detection: use liquidity figures from the V2 API directly.
      const v2BadDebt = await detectV2BadDebt(v2Vaults, chain);
      const v2Metadata = await getTokenInfoMap(chain, v2BadDebt);
      v2BadDebt.forEach((vault) => {
        const { symbol, decimals } = v2Metadata[vault] ?? {};
        if (!symbol || !decimals) return;
        addToDBWritesList(
          writes,
          chain,
          vault,
          0,
          decimals,
          symbol,
          timestamp,
          "morpho",
          1.01,
        );
      });
    }),
  );

  return writes;
}

export const adapters = {
  morphoBlue,
  lista,
} as any;
