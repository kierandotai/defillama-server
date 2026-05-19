import { fetch } from "../utils";
import { chainIdMap } from "./celer";

const nonEvmMapping: { [key: string]: string } = {
  solana: "solana",
  aptos: "aptos",
  ton: "ton",
  movement: "move",
  "sui-mainnet": "sui",
};

export default async function main() {
  const mappings: any[] = [];

  const chains = (await fetch(
    "https://metadata.layerzero-api.com/v1/metadata",
  )) as { [chain: string]: any };

  const chainKeys: { [key: string]: number } = {};
  Object.keys(chains).map((chain) => {
    if (chain.endsWith("-testnet")) return;
    if (!chains[chain].chainDetails) return;

    const { chainType, chainId, nativeChainId } = chains[chain].chainDetails;
    if (chainType != "evm" && !nonEvmMapping[chain]) {
      // console.log(`${chain} is not an evm chain`);
      return;
    }

    const destinationChainSlug =
      chainIdMap[chainId] ?? chainIdMap[nativeChainId];
    if (!destinationChainSlug) {
      // console.log(`destination chain ${chain} is not in the chainIdMap`);
      return;
    }

    chainKeys[chain] = chainId ?? nativeChainId;
  });

  Object.keys(chains).map((chain) => {
    if (!chains[chain].tokens) return;
    const chainId = chainKeys[chain];
    if (!chainId && !nonEvmMapping[chain]) return;
    const destinationChainSlug = chainIdMap[chainId] ?? nonEvmMapping[chain];

    Object.keys(chains[chain].tokens).map((destinationAddress: string) => {
      const { peggedTo, decimals, symbol } =
        chains[chain].tokens[destinationAddress];
      if (!peggedTo || !decimals || !symbol) {
        // console.log(`${destinationAddress} not enough info about peg`);
        return;
      }
      const { address: originAddress, chainName } = peggedTo;
      const sourceChainSlug =
        chainIdMap[chainKeys[chainName]] ?? nonEvmMapping[chainName];
      if (!sourceChainSlug) {
        // console.log(`source chain ${chainName} is not in the chainIdMap`);
        return;
      }

      mappings.push({
        from: `${destinationChainSlug}:${destinationAddress}`,
        to: `${sourceChainSlug}:${originAddress}`,
        symbol,
        decimals,
      });
    });
  });

  return mappings;
}
