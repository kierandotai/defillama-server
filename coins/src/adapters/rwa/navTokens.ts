import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import axios from "axios";

// --- Set 1: NAV-priced tokens (Ethereum) ---
// On-chain: latestNAV() / NAVScalingFactor() gives price in navCcy
const set1Chain = "ethereum";
const set1Tokens = [
  { address: "0x2833a5d960c56437C242e9594eec463f58996995", symbol: "CAMMF", navCcy: "HKD" },
  { address: "0xff40d8a2f9fc662d0b9eee1ccc71ea52f77cf701", symbol: "CAMMR", navCcy: "CNY" },
  { address: "0xbf0abbfb0be2eb47464412ddf50a57daaa366f49", symbol: "CAMMU", navCcy: "USD" },
  { address: "0xe07b5579afbdd2c0e220ea95f4b2c3e900ce3bb5", symbol: "CAMFF", navCcy: "HKD" },
  { address: "0x75bA0077D78c78e24018C2dFDC4722493b281014", symbol: "RYT", navCcy: "USD" },
  { address: "0x1AAa3339572Cf88Dc487DbEeF263F5AaBC5f3BBf", symbol: "CUMBU", navCcy: "USD" },
  { address: "0xdbf879f356c6b8c5f1edfdcb2950eda8b3ad25d9", symbol: "CUMFU", navCcy: "USD" },
  { address: "0x7Ab37F9b7d84A7EC009da4956968C289Dc3FB217", symbol: "CRMBR", navCcy: "CNY" },
  { address: "0x4fead114597fba40c37cf841fb48adb3fd5c60c9", symbol: "CRMFR", navCcy: "CNY" },
  { address: "0x1884dfaa3464C95bd67F47933Ea9b35396a52187", symbol: "AICRT", navCcy: "CNY" },
  { address: "0x237c717df1b60501F8d029D3fE7385fD090DF180", symbol: "BELIF USD", navCcy: "USD" },
  { address: "0xfACC10a1d551bEF84c90f1dA97FD0aD0863479Ac", symbol: "AICHT", navCcy: "HKD" },
  { address: "0x85D38585c3aC08268F598282a84b7c0Ddfc0d04F", symbol: "CUMIU", navCcy: "USD" },
  { address: "0x112089A3dA00fcC4E8A825439cbD8165D1CED21a", symbol: "CUMAU", navCcy: "USD" },
];

// --- Set 2: Manager-priced multi-chain tokens ---
// On-chain: lastSetMintExchangeRate() / BPS_DENOMINATOR() gives USD price
const set2Funds = [
  {
    symbol: "ULTRA",
    deployments: [
      { chain: "ethereum", address: "0x50293dd8889b931eb3441d2664dce8396640b419", manager: "0x9056777ad890ece386d646a5c698a9a6a779000b" },
      { chain: "solana", address: "9DRPPWYud8i6CaSsDsFESs1xyVr8dBCMtjPZji2xiZEa", manager: "" },
      { chain: "arbitrum", address: "0xc26aF85EDe9cc25d449BCebEF866bB85afd5D346", manager: "0x33A5038ad4D4185c4719C3bE2CFBF56327E334F0" },
      { chain: "avax", address: "0x51626DB85482b2Fa9901271c18627ebEFa8875AC", manager: "0xda92C74bE76ac8FDC040A88CffA4D302DCf1A54c" },
    ],
  },
  {
    symbol: "MG999",
    deployments: [
      { chain: "ethereum", address: "0xe85819ec5c5c27c336a4452cf323243af7aa3039", manager: "0x0f37EeDfe1f6e010254135BdFEd0255f79Ab5Ac6" },
      { chain: "arbitrum", address: "0xb641a65641abb9cc23406ad870e4ac015cf36663", manager: "0x339895f757A8D26d6F219c0C23da1f7f748c1f82" },
      { chain: "avax", address: "0x0134fADEb422b95F494E8C0619Ee832DACcF9C4B", manager: "0x14D49AF7902772b02774264d6C7F42381B6001e8" },
      { chain: "solana", address: "6n7cAJkvrsmweb4zmuDEvZxk2V68Uq8WKjtCYXmwtBLZ", manager: "" },
    ],
  },
];

async function getForexRates(): Promise<Record<string, number>> {
  const { data } = await axios.get("https://open.er-api.com/v6/latest/USD");
  if (data.result !== "success") throw new Error("Failed to fetch forex rates");
  return {
    USD: 1,
    HKD: 1 / data.rates.HKD,
    CNY: 1 / data.rates.CNY,
  };
}

async function getSolanaTokenDecimals(mints: string[]): Promise<number[]> {
  if (mints.length === 0) return [];
  try {
    const endpoint = process.env.SOLANA_RPC || "https://rpc.ankr.com/solana";
    const body = mints.map((mint, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "getTokenSupply",
      params: [mint],
    }));
    const { data } = await axios.post(endpoint, body);
    return data.map((r: any) => r.result?.value?.decimals ?? 6);
  } catch (e) {
    console.error("Failed to fetch Solana token decimals, using default 6:", (e as any).message);
    return mints.map(() => 6);
  }
}

async function priceSet1(timestamp: number): Promise<Write[]> {
  const api = await getApi(set1Chain, timestamp);
  const addresses = set1Tokens.map((t) => t.address);

  const [navs, scalings, decimalsResults, forexRates] = await Promise.all([
    api.multiCall({ abi: "uint256:latestNAV", calls: addresses, permitFailure: true }),
    api.multiCall({ abi: "uint256:NAVScalingFactor", calls: addresses, permitFailure: true }),
    api.multiCall({ abi: "uint8:decimals", calls: addresses, permitFailure: true }),
    getForexRates(),
  ]);

  const writes: Write[] = [];
  for (let i = 0; i < set1Tokens.length; i++) {
    const { address, symbol, navCcy } = set1Tokens[i];
    const nav = Number(navs[i]);
    const scaling = Number(scalings[i]);
    const decimals = Number(decimalsResults[i]);
    if (!nav || !scaling || scaling === 0 || !decimals) continue;

    const priceUsd = (nav / scaling) * (forexRates[navCcy] ?? 1);
    addToDBWritesList(writes, set1Chain, address, priceUsd, decimals, symbol, timestamp, "nav-tokens", 0.9);
  }
  return writes;
}

async function priceSet2(timestamp: number): Promise<Write[]> {
  const writes: Write[] = [];

  type EvmEntry = { fundIdx: number; deployIdx: number; address: string; manager: string };
  type SolEntry = { fundIdx: number; deployIdx: number; address: string };
  const evmByChain: { [chain: string]: EvmEntry[] } = {};
  const solByChain: { [chain: string]: SolEntry[] } = {};
  set2Funds.forEach((fund, fundIdx) => {
    fund.deployments.forEach((d, deployIdx) => {
      if (d.chain === "solana") {
        (solByChain[d.chain] ??= []).push({ fundIdx, deployIdx, address: d.address });
      } else if (d.manager) {
        (evmByChain[d.chain] ??= []).push({ fundIdx, deployIdx, address: d.address, manager: d.manager });
      }
    });
  });

  // Per-fund exchange rate is read from the first EVM deployment that has a manager.
  const fundPrimary: { [fundIdx: number]: { chain: string; manager: string } } = {};
  set2Funds.forEach((fund, fundIdx) => {
    const primary = fund.deployments.find((d) => d.manager && d.chain !== "solana");
    if (primary) fundPrimary[fundIdx] = { chain: primary.chain, manager: primary.manager };
  });

  const evmChains = Object.keys(evmByChain);
  const solChains = Object.keys(solByChain);

  const evmDecimalsByChain: { [chain: string]: any[] } = {};
  const evmManagerData: { [chain: string]: { rates: any[]; denoms: any[]; fundIdxs: number[] } } = {};

  await Promise.all([
    ...evmChains.map(async (chain) => {
      const api = await getApi(chain, timestamp);
      const entries = evmByChain[chain];
      // Funds whose primary manager is on this chain
      const primaryFundIdxs = Object.entries(fundPrimary)
        .filter(([_, p]) => p.chain === chain)
        .map(([idx]) => Number(idx));
      const managers = primaryFundIdxs.map((idx) => fundPrimary[idx].manager);
      const [decimals, rates, denoms] = await Promise.all([
        api.multiCall({ abi: "uint8:decimals", calls: entries.map((e) => e.address), permitFailure: true }),
        api.multiCall({ abi: "uint256:lastSetMintExchangeRate", calls: managers, permitFailure: true }),
        api.multiCall({ abi: "uint256:BPS_DENOMINATOR", calls: managers, permitFailure: true }),
      ]);
      evmDecimalsByChain[chain] = decimals;
      evmManagerData[chain] = { rates, denoms, fundIdxs: primaryFundIdxs };
    }),
    ...solChains.map(async (chain) => {
      const entries = solByChain[chain];
      const decimals = await getSolanaTokenDecimals(entries.map((e) => e.address));
      evmDecimalsByChain[chain] = decimals;
    }),
  ]);

  // Build per-fund price from primary manager data
  const fundPrices: { [fundIdx: number]: number } = {};
  for (const [fundIdxStr, p] of Object.entries(fundPrimary)) {
    const fundIdx = Number(fundIdxStr);
    const { rates, denoms, fundIdxs } = evmManagerData[p.chain] ?? { rates: [], denoms: [], fundIdxs: [] };
    const i = fundIdxs.indexOf(fundIdx);
    if (i < 0) continue;
    const rate = rates[i];
    const denom = denoms[i];
    if (!rate || !denom || Number(denom) === 0) continue;
    fundPrices[fundIdx] = Number(rate) / Number(denom);
  }

  for (const chain of evmChains) {
    evmByChain[chain].forEach((e, i) => {
      const price = fundPrices[e.fundIdx];
      const decimals = evmDecimalsByChain[chain][i];
      if (price === undefined || decimals == null) return;
      addToDBWritesList(writes, chain, e.address, price, Number(decimals), set2Funds[e.fundIdx].symbol, timestamp, "nav-tokens", 0.9);
    });
  }
  for (const chain of solChains) {
    solByChain[chain].forEach((e, i) => {
      const price = fundPrices[e.fundIdx];
      const decimals = evmDecimalsByChain[chain][i];
      if (price === undefined || decimals == null) return;
      addToDBWritesList(writes, chain, e.address, price, Number(decimals), set2Funds[e.fundIdx].symbol, timestamp, "nav-tokens", 0.9);
    });
  }

  return writes;
}

export async function navTokens(timestamp: number = 0): Promise<Write[]> {
  const writes: Write[] = [];
  const tasks = [priceSet1(timestamp), priceSet2(timestamp)];
  for (const task of tasks) {
    try {
      writes.push(...(await task));
    } catch (e) {
      console.error("navTokens partial failure:", e);
    }
  }
  return writes;
}
