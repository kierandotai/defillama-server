import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./utils";
import getWrites from "../utils/getWrites";

const oreStakeProgram = new PublicKey(
  "STkEAu2cEyQp5ktgUauRVq8es6mEP2w6ixw4NEd5tDJ"
);
const mint = "sTorERYB6xAZ1SSbwpK3zoK2EEwbBrc7TZAzg1uCGiH";
const underlying = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";

export async function stORE(timestamp: number = 0) {
  if (timestamp != 0) throw new Error(`stORE must only run at timestamp = 0`);

  const connection = getConnection();
  const tokenInfo = await connection.getAccountInfo(new PublicKey(mint));

  if (!tokenInfo) throw new Error(`stORE mint account not found`);
  if (tokenInfo.data.length < 46) throw new Error(`Invalid stORE mint account`);
  if (tokenInfo.data.readUInt32LE(0) !== 1)
    throw new Error(`stORE mint has no mint authority`);

  const mintAuthority = new PublicKey(tokenInfo.data.subarray(4, 36));
  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), mintAuthority.toBuffer()],
    oreStakeProgram
  );
  const stateInfo = await connection.getAccountInfo(state);

  if (!stateInfo) throw new Error(`stORE stake account not found`);
  if (stateInfo.data.length < 48)
    throw new Error(`Invalid stORE stake account`);
  if (Number(stateInfo.data.readBigUInt64LE(0)) !== 108)
    throw new Error(`Invalid stORE stake account type`);

  const supply = Number(tokenInfo.data.readBigUInt64LE(36));
  if (!supply) throw new Error(`stORE supply is zero`);

  const tokensDeposited = Number(stateInfo.data.readBigUInt64LE(40));

  return getWrites({
    chain: "solana",
    timestamp,
    pricesObject: {
      [mint]: {
        underlying,
        symbol: "stORE",
        decimals: 11,
        price: tokensDeposited / supply,
      },
    },
    projectName: "stORE",
  });
}
