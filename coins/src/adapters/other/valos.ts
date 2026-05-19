import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import getWrites from "../utils/getWrites";

const chain = "monad";
const adapter = "valos";

const VUSD = "0x8d3F9f9Eb2f5E8B48EFBB4074440D1E2A34Bc365";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";

export async function valos(timestamp: number = 0): Promise<Write[]> {

  const api = await getApi(chain, timestamp);
  const roundData = await api.call({ target: VUSD, abi: 'uint256:sharePrice', });
  const pricesObject = { [VUSD]: { price: roundData / 1e36, underlying: AUSD, }, }

  return getWrites({ chain, timestamp, pricesObject, projectName: adapter, });
}
