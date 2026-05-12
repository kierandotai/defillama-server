import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import getWrites from "../utils/getWrites";

const chain = "monad";
const adapter = "valos";

const VUSD = "0x8d3F9f9Eb2f5E8B48EFBB4074440D1E2A34Bc365";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const CHAINLINK_FEED = "0xf07e835C4Ec57ED880159aEF393E8fF9F66e75c0";

export async function valos(timestamp: number = 0): Promise<Write[]> {
  const api = await getApi(chain, timestamp);

  // Morpho oracle prices are scaled by 1e36.
  const roundData = await api.call({ target: CHAINLINK_FEED, abi: 'uint256:price', });
  const vUsdPerAusd = roundData / 1e36
  if (!Number.isFinite(vUsdPerAusd) || vUsdPerAusd < 0.5 || vUsdPerAusd > 2) {
    throw new Error(`Invalid oracle price for vUSD/AUSD: ${vUsdPerAusd}`);
  }

  const pricesObject = {
    [VUSD]: { price: vUsdPerAusd, underlying: AUSD, },
  }

  return getWrites({ chain, timestamp, pricesObject, projectName: adapter, });
}
