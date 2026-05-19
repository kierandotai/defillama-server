import * as sdk from "@defillama/sdk";
import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import getBlock from "../utils/block";
import { checkOracleFresh } from "../utils/oracle";
const { call } = sdk.api.abi;

const dCOMPToken = "0x91d14789071e5E195FFC9F745348736677De3292";
const dCOMPUSDOracle = "0x0798dE3DDb22c289A653c020863AaA7ef33C05d7";
// Underlying Chainlink-style aggregators composed by the Morpho-style wrapper above.
// The wrapper's *_FEED_* slots are constructor-set and immutable; a Morpho oracle
// upgrade would deploy a new wrapper, requiring a new adapter entry anyway.
const PEG_FEED = "0xe9aE06c316E5d986D81aD662a03A96D530cEe686";
const PRICE_FEED = "0x62555E33B8bb02DEAB8062F42EcaC151E7DcD958";
const SCALE = 1e24;
const chain = "ethereum";

export async function dCOMP(timestamp: number = 0): Promise<Write[]> {
  const writes: Write[] = [];
  const block = await getBlock(chain, timestamp);

  const [priceRes, pegTsRes, priceTsRes] = await Promise.all([
    call({ target: dCOMPUSDOracle, abi: "uint256:price", chain, block }),
    call({ target: PEG_FEED, abi: "uint256:latestTimestamp", chain, block }),
    call({ target: PRICE_FEED, abi: "uint256:latestTimestamp", chain, block }),
  ]);

  checkOracleFresh(pegTsRes.output, { timestamp, label: "dCOMP-peg-feed" });
  checkOracleFresh(priceTsRes.output, { timestamp, label: "dCOMP-price-feed" });

  const price = Number(priceRes.output) / SCALE;
  addToDBWritesList(writes, chain, dCOMPToken, price, 18, "dCOMP", timestamp, "dCOMP", 0.9);
  return writes;
}
