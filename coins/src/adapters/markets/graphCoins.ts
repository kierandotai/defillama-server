
import getWrites from "../utils/getWrites";
import { getApi } from "../utils/sdk";
import { graph, } from "@defillama/sdk"

type BlockQueryArgs = {
  block: number;
  minVolume?: number
  minTVL?: number
}

// Require the token to have a "real" base-paired pool: at least this much
// trusted-side value (denominated in the subgraph's ETH unit) summed across
// pools the subgraph itself considers whitelisted for this token. Without
// this floor, a memecoin paired with $5 of WETH can publish whatever price a
// manipulated tick implies.
const MIN_TRUSTED_SIDE_ETH = 0.5;

const defaultQuery = ({ block, minVolume = 100, minTVL = 100 }: BlockQueryArgs) => `{
  tokens (where: {
    volumeUSD_gt: ${minVolume}
    totalValueLockedUSD_gt: ${minTVL}
  } block: {number: ${block - 100}} orderBy: totalValueLockedUSD orderDirection: desc first: 1000) {
    id
    symbol
    poolCount
    totalValueLockedUSD
    totalValueLocked
    volumeUSD
    derivedETH
    decimals
    symbol
  }
}`

// Same as defaultQuery, but also pulls the top whitelistPools so we can
// enforce the trusted-side liquidity floor. Only safe to use against
// Uniswap V3 / Pancake V3 schemas that expose this field.
const hardenedQuery = ({ block, minVolume = 100, minTVL = 100 }: BlockQueryArgs) => `{
  tokens (where: {
    volumeUSD_gt: ${minVolume}
    totalValueLockedUSD_gt: ${minTVL}
  } block: {number: ${block - 100}} orderBy: totalValueLockedUSD orderDirection: desc first: 1000) {
    id
    symbol
    poolCount
    totalValueLockedUSD
    totalValueLocked
    volumeUSD
    derivedETH
    decimals
    whitelistPools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      totalValueLockedToken0
      totalValueLockedToken1
      token0 { id derivedETH }
      token1 { id derivedETH }
    }
  }
}`

function trustedSideEthFromWhitelistPools(token: any): number {
  const pools = token.whitelistPools;
  if (!Array.isArray(pools) || !pools.length) return 0;
  const tokenId = token.id.toLowerCase();
  let best = 0;
  for (const pool of pools) {
    const isToken0 = pool.token0?.id?.toLowerCase() === tokenId;
    const otherBal = +(isToken0 ? pool.totalValueLockedToken1 : pool.totalValueLockedToken0);
    const otherDerivedEth = +(isToken0 ? pool.token1?.derivedETH : pool.token0?.derivedETH);
    if (!(otherBal > 0) || !(otherDerivedEth > 0)) continue;
    const sideEth = otherBal * otherDerivedEth;
    if (sideEth > best) best = sideEth;
  }
  return best;
}

function getGraphCoinsAdapter({ chain, endpoint, minVolume = 1e4, minTVL = 1e5, projectName = 'graph-coins', query, requireTrustedSideEth = MIN_TRUSTED_SIDE_ETH }: { chain: string, endpoint: string, minVolume?: number, minTVL?: number, projectName?: string, query?: (args: BlockQueryArgs) => string, requireTrustedSideEth?: number }) {
  // hardenedQuery is required for the trusted-side floor — it adds the
  // whitelistPools sub-selection. Callers without an explicit override pick
  // it automatically when requireTrustedSideEth is set.
  const effectiveQuery = query ?? (requireTrustedSideEth > 0 ? hardenedQuery : defaultQuery);
  async function adapter(timestamp: number = 0) {
    const chainApi = await getApi(chain, timestamp);
    const block = await chainApi.getBlock();
    const queryString = effectiveQuery({ block, minVolume, minTVL });
    const { tokens } = await graph.request(endpoint, queryString);
    const pricesObject: any = {}
    let droppedThin = 0;
    tokens.forEach((token: any) => {
      if (token.totalValueLockedUSD > 51 * 1e6) {
        // console.log(`coin: ${token.id} has too high TVL (${Number(token.totalValueLockedUSD / 1e6).toFixed(2)}M), skipping`)
        return;
      }
      if (requireTrustedSideEth > 0 && Array.isArray(token.whitelistPools)) {
        const bestEth = trustedSideEthFromWhitelistPools(token);
        if (bestEth < requireTrustedSideEth) {
          droppedThin++;
          return;
        }
      }
      let price = token.totalValueLockedUSD / token.totalValueLocked
      let underlying: any = undefined
      if (!price && token.derivedETH) {
        price = token.derivedETH
        underlying = '0x0000000000000000000000000000000000000000'
      }
      pricesObject[token.id] = {
        price,
        underlying,
        symbol: token.symbol,
        decimals: token.decimals,
      }
    })
    if (droppedThin)
      console.log(`graphCoins ${projectName}: dropped ${droppedThin} tokens below ${requireTrustedSideEth} ETH trusted-side floor`);
    return getWrites({ chain, timestamp, pricesObject, projectName, });
  }

  async function beraswapAdapter(timestamp: number = 0) {
    const poolsQuery = `{
      poolGetPools(first: 1000, orderBy: totalLiquidity, orderDirection: desc, where: { minTvl: ${minTVL} }) {
        address
      }
    }`
    const { poolGetPools } = await graph.request(endpoint, poolsQuery)
    const addresses: string[] = poolGetPools.map((p: any) => p.address)

    const pricesObject: any = {}
    if (!addresses.length) return getWrites({ chain, timestamp, pricesObject, projectName, })

    const pricesQuery = `{
      tokenGetCurrentPrices(addressIn: ${JSON.stringify(addresses)}, chains: [BERACHAIN]) {
        price
        address
      }
    }`
    const { tokenGetCurrentPrices } = await graph.request(endpoint, pricesQuery)
    tokenGetCurrentPrices.forEach((token: any) => {
      if (!token?.price) return
      pricesObject[token.address] = { price: token.price }
    })
    return getWrites({ chain, timestamp, pricesObject, projectName, })
  }

  switch (projectName) {
    case 'beraswap': return beraswapAdapter;
  }

  return adapter;
}

export const adapters = {} as any;

const taraswapQuery = ({ block, }: BlockQueryArgs) => `{
  tokens (where: {
    derivedETH_gt: 0
    volumeUSD_gt: 1000
    totalValueLockedUSD_gt: 1000
  } block: {number: ${block - 100}} first: 1000) {
    id
    symbol
    derivedETH
    decimals
    symbol
  }
}`

// Uniswap V3 official subgraph IDs (Graph Network). Source: DefiLlama-Adapters/projects/uniswap/index.js
// These cover the long tail of tokens that have V3 pools but aren't picked up by the V2-fork
// discovery in markets/uniswap/index.ts. Major tokens are filtered out upstream by the
// `totalValueLockedUSD > 51 * 1e6` cap in getGraphCoinsAdapter — this adapter targets the
// unpriced long tail only.
const uniV3 = (id: string) => graph.modifyEndpoint(id);

const items = [
  { chain: 'ace', endpoint: 'https://endurance-subgraph-v2.fusionist.io/subgraphs/name/catalist/exchange-v3-v103', minTVL: 1e4, projectName: 'catalist' },
  { chain: 'vana', endpoint: 'https://api.goldsky.com/api/public/project_clnbo3e3c16lj33xva5r2aqk7/subgraphs/data-dex-vana/prod/gn', minTVL: 1e4, projectName: 'datadex' },
  { chain: 'tara', endpoint: 'https://indexer.lswap.app/subgraphs/name/taraxa/uniswap-v3', minTVL: 1e4, projectName: 'taraswap', },
  { chain: 'berachain', endpoint: 'https://api.berachain.com/', minTVL: 1e4, projectName: 'beraswap', },
  { chain: 'ethereum', endpoint: uniV3('5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV'), minTVL: 1e4, minVolume: 1e4, projectName: 'uniswap-v3-ethereum', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  { chain: 'base',     endpoint: uniV3('43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG'), minTVL: 1e4, minVolume: 1e4, projectName: 'uniswap-v3-base', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  { chain: 'arbitrum', endpoint: uniV3('CJYGNhb7RvnhfBDjqpRnD3oxgyhibzc7fkAMa38YV3oS'), minTVL: 1e4, minVolume: 1e4, projectName: 'uniswap-v3-arbitrum', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  { chain: 'polygon',  endpoint: uniV3('3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm'), minTVL: 1e4, minVolume: 1e4, projectName: 'uniswap-v3-polygon', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  { chain: 'optimism', endpoint: uniV3('Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj'), minTVL: 1e4, minVolume: 1e4, projectName: 'uniswap-v3-optimism', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  { chain: 'celo',     endpoint: uniV3('ESdrTJ3twMwWVoQ1hUE2u7PugEHX3QkenudD6aXCkDQ4'), minTVL: 1e4, minVolume: 1e4, projectName: 'uniswap-v3-celo', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  // PancakeSwap V3 — dominant V3 venue on BSC, also strong on arbitrum. Same Uni V3 subgraph schema.
  { chain: 'bsc',      endpoint: uniV3('Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ'), minTVL: 1e4, minVolume: 1e4, projectName: 'pancakeswap-v3-bsc', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
  { chain: 'arbitrum', endpoint: uniV3('251MHFNN1rwjErXD2efWMpNS73SANZN8Ua192zw6iXve'), minTVL: 1e4, minVolume: 1e4, projectName: 'pancakeswap-v3-arbitrum', requireTrustedSideEth: MIN_TRUSTED_SIDE_ETH },
]

items.forEach((config: any) => adapters[config.projectName] = getGraphCoinsAdapter(config));