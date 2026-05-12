import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList } from "../utils/database";
import { checkOracleFresh } from "../utils/oracle";
const abi = 'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'

export async function hashnote(timestamp: number): Promise<Write[]> {
    const symbol = 'USYC'
    const api = await getApi("ethereum", timestamp);
    const roundData = await api.call({ abi, target: "0x74f2199AEb743f68f05943e5715A33EaF2b61f53", });
    checkOracleFresh(roundData.updatedAt, { timestamp, label: "USYC", maxAgeSeconds: 4 * 24 * 60 * 60 });
    const tokenPrice = roundData.answer / 1e18;

    const writes: Write[] = [];
    addToDBWritesList(writes, 'canto', '0xfb8255f0de21acebf490f1df6f0bdd48cc1df03b', tokenPrice, 6, symbol, timestamp, "hashnote-rwa", 1,);
    addToDBWritesList(writes, 'ethereum', '0x136471a34f6ef19fe571effc1ca711fdb8e49f2b', tokenPrice, 6, symbol, timestamp, "hashnote-rwa", 1,);

    return writes;
}
