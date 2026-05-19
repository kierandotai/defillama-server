import axios from "axios";
import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList, getTokenAndRedirectDataMap } from "../utils/database";
import { getApi } from "../utils/sdk";

const chain = "tempo";
const pathUSDAddress = "0x20c0000000000000000000000000000000000000";
const stablecoinDex = "0xdec0000000000000000000000000000000000000";
const tokenListUrl = "https://tokenlist.tempo.xyz/list/4217";

export async function pathUSD(timestamp: number = 0): Promise<Write[]> {
  const writes: Write[] = [];
  const api = await getApi(chain, timestamp);

  const { data: list } = await axios.get(tokenListUrl);
  const tokens: { address: string; decimals: number; symbol: string }[] = list.tokens
    .map((t: any) => ({
      address: t.address.toLowerCase(),
      decimals: t.decimals,
      symbol: t.symbol,
    }))
    .filter((t: any) => t.address !== pathUSDAddress);

  const balances: string[] = await api.multiCall({
    abi: "erc20:balanceOf",
    calls: tokens.map((t) => ({ target: t.address, params: stablecoinDex })),
    permitFailure: true,
  });

  const priceMap = await getTokenAndRedirectDataMap(
    tokens.map((t) => t.address),
    chain,
    timestamp,
  );

  let valueSum = 0;
  let weightSum = 0;
  for (let i = 0; i < tokens.length; i++) {
    const balRaw = balances[i];
    const coin = priceMap[tokens[i].address];
    if (!balRaw || !coin?.price || coin.confidence == null || coin.confidence < 0.5) continue;
    if (coin.price < 0.5 || coin.price > 1.5) continue;
    const bal = Number(balRaw) / 10 ** tokens[i].decimals;
    if (!isFinite(bal) || bal <= 0) continue;
    valueSum += bal * coin.price;
    weightSum += bal;
  }

  if (weightSum <= 0) return writes;
  const price = valueSum / weightSum;
  if (!isFinite(price) || price <= 0) return writes;

  addToDBWritesList(
    writes,
    chain,
    pathUSDAddress,
    price,
    6,
    "pathUSD",
    timestamp,
    "pathUSD",
    0.9,
  );

  return writes;
}