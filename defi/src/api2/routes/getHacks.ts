import protocols from "../../protocols/data";
import { getAllAirtableRecords } from "../../utils/airtable";
import {
  cleanString,
  normalizeAmount,
  normalizeChain,
  normalizeTechnique,
  parseHackDate,
} from "../utils/normalizeHacks";

export async function getHacksInternal() {
  let allRecords = await getAllAirtableRecords("appNED1rpGDbQDjEX/Hacks");
  return allRecords
    .filter((r) => r.fields["Name"] !== undefined)
    .map((r) => {
      const defillamaId = r.fields["DefiLlama Id"] ?? null;
      const protocol = defillamaId ? protocols.find((p) => p.id == defillamaId) : null;
      const date = parseHackDate(r.fields["Date"]);

      return {
        date,
        name: protocol?.name ?? cleanString(r.fields["Name"]) ?? r.fields["Name"],
        classification: cleanString(r.fields["Classification"]),
        technique: normalizeTechnique(r.fields["Technique"]),
        amount: normalizeAmount(r.fields["Funds Lost"]),
        chain: normalizeChain(r.fields["Chain"]),
        bridgeHack: r.fields["Bridge / Multichain Application"] ?? false,
        targetType: cleanString(r.fields["Target Type"]),
        source: "",
        returnedFunds: normalizeAmount(r.fields["Refunded funds to users"]),
        defillamaId,
        ...(protocol?.parentProtocol ? { parentProtocolId: protocol.parentProtocol } : {}),
        language: cleanString(r.fields["Language"]),
      };
    })
    // Drop records with no parseable date — they cannot be charted or sorted
    // and previously surfaced as `NaN` in the API response.
    .filter((h) => h.date !== null);
}
