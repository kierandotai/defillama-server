import { addToDBWritesList, getTokenAndRedirectData } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import { getTokenInfo } from "../utils/erc20";
import getBlock from "../utils/block";
import * as sdk from '@defillama/sdk'
const { call, } = sdk.api.abi;
// odpxWETH-USDC
const chain = "arbitrum";
const orangeVault = "0xe1B68841E764Cc31be1Eb1e59d156a4ED1217c2C";
const odpx_vault = "0xb2aD0378dC0232c0A40b82C9675D9Df172C693e3";

const targets = [orangeVault];

export default async function getTokenPrice(timestamp: number) {
  const block: number | undefined = await getBlock(chain, timestamp);
  const writes: Write[] = [];
  await contractCalls(targets, block, writes, timestamp);
  return writes;
}

async function contractCalls(
  targets: string[],
  block: number | undefined,
  writes: Write[],
  timestamp: number,
) {
  const [balance, tokenInfos] = await Promise.all([
    call({
      target: targets[0],
      params: odpx_vault,
      chain,
      abi: abi.balanceOf,
      block,
    }),
    getTokenInfo(chain, [targets[0]], block),
  ]);

  const [val] = await Promise.all([
    call({
      target: targets[0],
      params: balance.output,
      chain,
      abi: abi.convertToAssets,
      block,
    }),
  ]);

  const [{ price: priceEth }] = await getTokenAndRedirectData(
    ["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"],
    "arbitrum",
    timestamp,
  );

  let price = (val.output * priceEth) / balance.output;

  if (isNaN(price)) return;

  addToDBWritesList(
    writes,
    chain,
    targets[0],
    price,
    tokenInfos.decimals[0].output,
    tokenInfos.symbols[0].output,
    timestamp,
    "odpxWETH-USDC",
    1,
  );
}

const abi = {
  "balanceOf": "function balanceOf(address _owner) view returns (uint256 balance)",
  "convertToAssets": "function convertToAssets(uint256) view returns (uint256)"
} ;
