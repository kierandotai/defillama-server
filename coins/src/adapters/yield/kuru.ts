import { Write, } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList, getTokenAndRedirectDataMap } from "../utils/database";


const abi = {
  "calculateNotionalValue": "function calculateNotionalValue() view returns (uint256, uint256)",
  "ctx": "function ctx() view returns (address book, uint32 pricePrecision, uint8 baseDecimals, uint8 quoteDecimals, address base, uint96 sizePrecision, address quote, uint40 head, uint40 tail)",
}

export const config = {
  monad: {
    vaults: [
      '0x4869a4c7657cef5e5496c9ce56dde4cd593e4923'
    ],
  },
} as any

async function getTokenPrices(chain: string, timestamp: number) {
  const api = await getApi(chain, timestamp)
  const vaults: string[] = config[chain]?.vaults ?? []
  if (!vaults.length) return []

  const [ctxs, notionals, supplies, symbols, decimals] = await Promise.all([
    api.multiCall({ calls: vaults, abi: abi.ctx, permitFailure: true }),
    api.multiCall({ calls: vaults, abi: abi.calculateNotionalValue, permitFailure: true }),
    api.multiCall({ calls: vaults, abi: "erc20:totalSupply", permitFailure: true }),
    api.multiCall({ calls: vaults, abi: "string:symbol", permitFailure: true }),
    api.multiCall({ calls: vaults, abi: "uint8:decimals", permitFailure: true }),
  ])

  const underlyings = Array.from(new Set(
    ctxs.flatMap((c: any) => c ? [c.base.toLowerCase(), c.quote.toLowerCase()] : [])
  ))
  const priceMap = await getTokenAndRedirectDataMap(underlyings, chain, timestamp)

  const writes: Write[] = []
  vaults.forEach((vault, i) => {
    const ctx = ctxs[i]
    const notional = notionals[i]
    const supply = supplies[i]
    if (!ctx || !notional || !supply || decimals[i] == null) return

    const basePrice = priceMap[ctx.base.toLowerCase()]
    const quotePrice = priceMap[ctx.quote.toLowerCase()]
    if (!basePrice || !quotePrice) return

    const baseAmount = Number(notional[0]) / 10 ** Number(ctx.baseDecimals)
    const quoteAmount = Number(notional[1]) / 10 ** Number(ctx.quoteDecimals)
    const tvl = baseAmount * basePrice.price + quoteAmount * quotePrice.price

    const shareSupply = Number(supply) / 10 ** Number(decimals[i])
    if (shareSupply === 0) return
    const price = tvl / shareSupply
    if (!isFinite(price) || price <= 0) return

    addToDBWritesList(
      writes,
      chain,
      vault,
      price,
      Number(decimals[i]),
      symbols[i] ?? "KURU-VAULT",
      timestamp,
      "kuru",
      0.9,
    )
  })

  return writes
}


export function kuru(timestamp: number = 0) {
  return Promise.all(Object.keys(config).map(i => getTokenPrices(i, timestamp)))
}
