import * as sdk from "@defillama/sdk";
import { request, gql } from "graphql-request";
import { addToDBWritesList, getTokenAndRedirectDataMap } from "../../utils/database";
import { getApi } from "../../utils/sdk";
import { Write } from "../../utils/dbInterfaces";

// Gets all vaults
const query = gql`
query AllVaults($skip: Int) {
  vaults(first: 1000, skip: $skip) {
    id
    isWhitelisted
    strategyType
    vaultToken {
      symbol
      decimals
    }
    yieldToken {
      id
      decimals
    }
    asset {
      id
      decimals
    }
  }
}
`;

const subgraphURL: {
  [key: string]: string
} = {
  ethereum: sdk.graph.modifyEndpoint("9fw42E6QrezaPxixKN9H79nWmpVWURkLmcJdgGHyC14B")
  // ethereum: "https://api.studio.thegraph.com/query/60626/notional-exponent/version/latest"
}

async function getVaults(subgraphURL: string) {
  const results: {
    id: string
    isWhitelisted: boolean
    strategyType: string
    vaultToken: {
      symbol: string
      decimals: number
    }
    yieldToken: {
      id: string
      decimals: number
    }
    asset: {
      id: string
      decimals: number
    }
  }[] = [];
  let skip = 0
  let hasMore = true
  while (hasMore) {
    const { vaults } = await request<{ vaults: typeof results }>(subgraphURL, query, { skip })
    results.push(...vaults)
    skip += 1000
    hasMore = vaults.length === 1000
  }

  return results
}

async function getYieldTokens(api: sdk.ChainApi, vaults: Awaited<ReturnType<typeof getVaults>>) {
  const curveVaults = vaults.filter((vault) => vault.strategyType === "CurveConvex2Token")
  const yieldTokens = await api.multiCall({
    calls: curveVaults.map((vault) => vault.id),
    abi: "function CURVE_POOL_TOKEN() view returns (address)",
    permitFailure: true,
  })

  const yieldTokenByVault: Record<string, string> = {}
  curveVaults.forEach((v, i) => {
    if (yieldTokens[i]) yieldTokenByVault[v.id] = yieldTokens[i]
  })

  return vaults.map((v) => ({
    vault: v.id,
    yieldToken: (yieldTokenByVault[v.id] || v.yieldToken.id).toLowerCase(),
  }))
}

async function getVaultPrices(api: sdk.ChainApi, vaults: string[]) {
  return api.multiCall({
    calls: vaults,
    abi: "function price() view returns (uint256)",
    permitFailure: true,
  })
}

async function getConvertSharesToYieldTokens(api: sdk.ChainApi, vaults: string[]) {
  const amount = (BigInt(10) ** BigInt(24)).toString()
  return api.multiCall({
    calls: vaults.map((v) => ({
      target: v,
      params: [amount],
    })),
    abi: "function convertSharesToYieldToken(uint256 amount) view returns (uint256)",
    permitFailure: true,
  })
}

export default async function getTokenPrices(chain: string, timestamp: number) {
  const api = await getApi(chain, timestamp, true)
  const vaults = await getVaults(subgraphURL[chain])
  const yieldTokens = await getYieldTokens(api, vaults)
  const yieldTokenPrices = await getTokenAndRedirectDataMap(yieldTokens.map((y) => y.yieldToken), chain, timestamp)
  const underlyingPrices = await getTokenAndRedirectDataMap(
    vaults.map((vault) => vault.asset.id),
    chain,
    timestamp,
  )
  const sharesPrices = await getConvertSharesToYieldTokens(api, vaults.map((vault) => vault.id))
  const vaultPrices = await getVaultPrices(api, vaults.map((vault) => vault.id))

  const writes: Write[] = [];
  vaults.forEach((vault, index) => {
    let price: number | undefined;
    const yieldToken = yieldTokens.find((y) => y.vault === vault.id)?.yieldToken
    const yieldTokenData = yieldToken ? yieldTokenPrices[yieldToken] : undefined
    if (yieldTokenData && sharesPrices[index]) {
      // These are the DefiLlama prices for the yield tokens. It should reflect up to date prices for
      // Curve Pool Tokens, PT Tokens and most staking tokens. We just discount it here by the vault shares
      // to yield token price,
      price = yieldTokenData.price * sharesPrices[index] / 10 ** yieldTokenData.decimals
    } else if (vaultPrices[index] && underlyingPrices[vault.asset.id]) {
      // If the DefiLlama price is not available, we use the on chain vault price.
      const assetDecimals = vault.asset.decimals
      const vaultPrice = vaultPrices[index] / (10 ** (assetDecimals + 12))
      price = vaultPrice * underlyingPrices[vault.asset.id].price
    }
    if (price === undefined || isNaN(price)) return

    addToDBWritesList(
      writes,
      chain,
      vault.id,
      price,
      vault.vaultToken.decimals,
      vault.vaultToken.symbol,
      timestamp,
      "notional",
      0.7
    )
  })

  return writes
}