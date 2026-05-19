import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList } from "../utils/database";
import { checkOracleFresh } from "../utils/oracle";

const oracles = {
  tryUsd: "0x1b0FDa12D125B864756Bbf191ad20eaB10915a6F",
  wiTryPerITry: "0x85C4F855Bc0609D2584405819EdAEa3aDAbfE97D",
};

const tokens: { [chain: string]: { iTRY: string; wiTRY: string } } = {
  ethereum: {
    iTRY: "0xb492B4aFD9658093694CF9452D5C272e8230F3B0",
    wiTRY: "0xE346C29b5B60Ef870b9724c57ccfbBc631e47DEE",
  },
  megaeth: {
    iTRY: "0x996ce957408804fEC19237D866799d9C7076E48c",
    wiTRY: "0x15B271D9012b5820FC42b1c495B4C1e206547De5",
  },
};

const latestRoundDataAbi =
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)";

// iTRY has no DefiLlama price source today (its CoinGecko entry brix-itry is
// still in Preview status), so this adapter is the only writer for iTRY.
// wiTRY is already priced via CoinGecko (wrapped-itry, Active) — confidence
// 0.9 keeps the CoinGecko value as the winner; these writes act as a chain-
// symmetric fallback so MegaETH LayerZero OFTs also get priced.
export async function brix(timestamp: number): Promise<Write[]> {
  const api = await getApi("megaeth", timestamp);

  const [tryUsd, wiTryPerITry] = await Promise.all([
    api.call({ abi: latestRoundDataAbi, target: oracles.tryUsd }),
    api.call({ abi: latestRoundDataAbi, target: oracles.wiTryPerITry }),
  ]);

  checkOracleFresh(tryUsd.updatedAt, { timestamp, label: "TRY/USD" });
  checkOracleFresh(wiTryPerITry.updatedAt, { timestamp, label: "wiTRY/iTRY" });

  const iTryUsd = Number(tryUsd.answer) / 1e8;
  const wiTryUsd = (Number(wiTryPerITry.answer) / 1e8) * iTryUsd;

  const writes: Write[] = [];
  for (const chain of Object.keys(tokens)) {
    addToDBWritesList(writes, chain, tokens[chain].iTRY, iTryUsd, 18, "iTRY", timestamp, "brix-itry", 0.9);
    addToDBWritesList(writes, chain, tokens[chain].wiTRY, wiTryUsd, 18, "wiTRY", timestamp, "brix-witry", 0.9);
  }

  return writes;
}
