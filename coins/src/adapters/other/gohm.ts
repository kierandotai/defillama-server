import { getApi } from "../utils/sdk";
import getWrites from "../utils/getWrites";

const gOHM = "0x0ab87046fBb341D058F17CBC4c1133F25a20a52f"
const OHM = "0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5"
const chain = "ethereum";

export default async function getTokenPrice(timestamp: number) {
  const api = await getApi('ethereum', timestamp);
  const [
    gOhmToOhmRate,
  ] = await Promise.all([
    api.call({ target: gOHM, abi: 'function balanceFrom(uint256) view returns (uint256)', params: [String(1e18)] })
  ])

  const pricesObject: any = {};
  pricesObject[gOHM] = {
    price: gOhmToOhmRate / 10 ** 9,
    underlying: OHM,
    decimals: 18,
    symbol: "gOHM",
    confidence: 1,
  };
  const writes = await getWrites({
    chain,
    timestamp,
    pricesObject,
    projectName: "gOHM",
  });
  return writes;
}
