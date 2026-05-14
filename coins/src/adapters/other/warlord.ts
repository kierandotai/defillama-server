import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { ChainApi } from "@defillama/sdk";
import { addToDBWritesList, getTokenAndRedirectData, getTokenAndRedirectDataMap } from "../utils/database";

const chain = "ethereum";
const projectName = "warlord";
const WAR_CONTROLLER = "0xFDeac9F9e4a5A7340Ac57B47C67d383fb4f13DBb";
const WAR_REDEEMER = "0x4787Ef084c1d57ED87D58a716d991F8A9CD3828C";
const WAR = "0xa8258deE2a677874a48F5320670A869D74f0cbC1";

async function getLockers(api: ChainApi): Promise<string[]> {
  const lockers: string[] = [];
  const CHUNK = 20;
  for (let start = 0; ; start += CHUNK) {
    const results = await api.multiCall({
      target: WAR_CONTROLLER,
      abi: "function lockers(uint256) view returns (address)",
      calls: Array.from({ length: CHUNK }, (_, j) => ({ params: [start + j] })),
      permitFailure: true,
    });
    let stopped = false;
    for (const r of results) {
      if (!r) {
        stopped = true;
        break;
      }
      lockers.push(r);
    }
    if (stopped) break;
  }
  return lockers;
}

export default async function getTokenPrice(timestamp: number) {
  const writes: Write[] = [];
  const api = await getApi(chain, timestamp);

  const lockers = await getLockers(api);

  const [bals, tokens, totalSupply, decimals, symbol] = await Promise.all([
    api.multiCall({
      abi: "uint256:getCurrentLockedTokens",
      calls: lockers.map((i) => ({ target: i })),
    }),
    api.multiCall({
      abi: "address:token",
      calls: lockers.map((i) => ({ target: i })),
    }),
    api.call({ target: WAR, abi: "erc20:totalSupply" }),
    api.call({ target: WAR, abi: "erc20:decimals" }),
    api.call({ target: WAR, abi: "erc20:symbol" }),
  ]);

  const tokensQueued = await api.multiCall({
    abi: "function queuedForWithdrawal(address) view returns (uint256)",
    calls: tokens.map((i) => ({ target: WAR_REDEEMER, params: [i] })),
  });

  const coinData = await getTokenAndRedirectDataMap(tokens, chain, timestamp);

  const price: number =
    tokens
      .map((token, i) => {
        const tokenInfo = coinData[token.toLowerCase()];
        const tokenPrice = tokenInfo!.price;
        const tokenDecimals = tokenInfo!.decimals;
        const tokenBal = bals[i];
        const tokensQueuedForWithdrawal = tokensQueued[i];
        return (
          ((tokenBal - tokensQueuedForWithdrawal) / 10 ** tokenDecimals) *
          tokenPrice
        );
      })
      .reduce((sum, current) => sum + current, 0) /
    (totalSupply / 10 ** decimals);

  addToDBWritesList(
    writes,
    chain,
    WAR,
    price,
    decimals,
    symbol,
    timestamp,
    projectName,
    0.99,
  );

  return writes;
}
