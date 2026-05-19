import { fetch } from "../utils";
import { Token } from "./index";

import { chainIdMap } from "../ethers";
export { chainIdMap } from "../ethers";

export default async function bridge(): Promise<Token[]> {
  const celerTokens = (
    await fetch("https://cbridge-prod2.celer.app/v2/getTransferConfigsForAll")
  ).pegged_pair_configs as any[];

  const tokens: Token[] = [];

  celerTokens.map((pp) => {
    const destinationChain = chainIdMap[pp.pegged_chain_id];
    let originChain = chainIdMap[pp.org_chain_id];
    const token = pp.pegged_token.token;
    let srcToken = pp.org_token.token.address;

    if (
      destinationChain === undefined ||
      originChain === undefined ||
      typeof srcToken !== "string"
    ) {
      return;
    }

    tokens.push({
      from: `${destinationChain}:${token.address}`,
      to: `${originChain}:${srcToken}`,
      symbol: token.symbol,
      decimals: token.decimal,
    });
  });

  return tokens;
}
