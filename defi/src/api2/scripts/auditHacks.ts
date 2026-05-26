// Audits the live `/hacks` endpoint and prints a report of data-quality
// issues that the maintainers can fix in Airtable. The script is read-only
// and does not mutate any data.
//
// Usage:
//   npx ts-node --logError --transpile-only defi/src/api2/scripts/auditHacks.ts
//   npx ts-node --logError --transpile-only defi/src/api2/scripts/auditHacks.ts --json > audit.json
//
// What it reports:
//   - Records with missing required fields (name, date, amount).
//   - Records with missing optional-but-useful fields (technique, chain,
//     classification).
//   - Technique values that look like near-duplicates of another value
//     (case- and whitespace-insensitive match against a more common variant).
//   - Records where returnedFunds exceeds amount (data entry error candidates).
//   - Records with invalid timestamps.

import axios from "axios";
import { TECHNIQUE_ALIASES } from "../utils/normalizeHacks";

type Hack = {
  name: string;
  date: number | null;
  amount: number | null;
  chain: string | string[] | null;
  technique: string | null;
  classification: string | null;
  source: string | null;
  returnedFunds: number | null;
  defillamaId: number | string | null;
};

const HACKS_URL = "https://api.llama.fi/hacks";

const LARGE_HACK_THRESHOLD = 10_000_000;

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined && value !== "";
}

function hasChain(hack: Hack): boolean {
  if (!isPresent(hack.chain)) return false;
  if (Array.isArray(hack.chain)) return hack.chain.length > 0;
  return true;
}

function findNearDuplicateTechniques(hacks: Hack[]): Array<{
  canonical: string;
  variant: string;
  variantCount: number;
  canonicalCount: number;
}> {
  const counts = new Map<string, number>();
  for (const h of hacks) {
    if (!h.technique) continue;
    counts.set(h.technique, (counts.get(h.technique) ?? 0) + 1);
  }

  // Group by a normalized key (case + whitespace + punctuation-insensitive).
  const groups = new Map<string, string[]>();
  const normKey = (s: string) =>
    s.toLowerCase().replace(/[\s\-_]+/g, "").replace(/[^a-z0-9]/g, "");

  for (const technique of counts.keys()) {
    const key = normKey(technique);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(technique);
  }

  const duplicates: Array<{
    canonical: string;
    variant: string;
    variantCount: number;
    canonicalCount: number;
  }> = [];

  for (const variants of groups.values()) {
    if (variants.length < 2) continue;
    // Canonical = highest-count variant; tie-break by lexicographic.
    const sorted = [...variants].sort((a, b) => {
      const ca = counts.get(a) ?? 0;
      const cb = counts.get(b) ?? 0;
      if (cb !== ca) return cb - ca;
      return a.localeCompare(b);
    });
    const canonical = sorted[0];
    for (const variant of sorted.slice(1)) {
      duplicates.push({
        canonical,
        variant,
        variantCount: counts.get(variant) ?? 0,
        canonicalCount: counts.get(canonical) ?? 0,
      });
    }
  }
  return duplicates;
}

function findKnownAliases(hacks: Hack[]): Array<{ name: string; technique: string; canonical: string }> {
  const out: Array<{ name: string; technique: string; canonical: string }> = [];
  for (const h of hacks) {
    if (h.technique && TECHNIQUE_ALIASES[h.technique]) {
      out.push({ name: h.name, technique: h.technique, canonical: TECHNIQUE_ALIASES[h.technique] });
    }
  }
  return out;
}

function findReturnedFundsExceedsAmount(hacks: Hack[]) {
  return hacks
    .filter(
      (h) =>
        typeof h.amount === "number" &&
        typeof h.returnedFunds === "number" &&
        h.returnedFunds > h.amount
    )
    .map((h) => ({
      name: h.name,
      amount: h.amount,
      returnedFunds: h.returnedFunds,
      diff: (h.returnedFunds ?? 0) - (h.amount ?? 0),
    }));
}

function summarize(hacks: Hack[]) {
  const total = hacks.length;
  const missingName = hacks.filter((h) => !isPresent(h.name)).length;
  const missingDate = hacks.filter(
    (h) => !isPresent(h.date) || !Number.isFinite(h.date as number)
  ).length;
  const missingAmount = hacks.filter((h) => !isPresent(h.amount)).length;
  const missingTechnique = hacks.filter((h) => !isPresent(h.technique)).length;
  const missingChain = hacks.filter((h) => !hasChain(h)).length;
  const missingClassification = hacks.filter((h) => !isPresent(h.classification)).length;
  const missingSource = hacks.filter((h) => !isPresent(h.source)).length;
  const largeMissingReturned = hacks.filter(
    (h) =>
      typeof h.amount === "number" &&
      h.amount >= LARGE_HACK_THRESHOLD &&
      !isPresent(h.returnedFunds)
  ).length;

  return {
    total,
    missingName,
    missingDate,
    missingAmount,
    missingTechnique,
    missingChain,
    missingClassification,
    missingSource,
    largeHacksMissingReturnedFunds: largeMissingReturned,
  };
}

function printTextReport(hacks: Hack[]) {
  const summary = summarize(hacks);
  console.log("===========================================");
  console.log("DefiLlama Hacks Endpoint - Data Quality Audit");
  console.log("===========================================");
  console.log("");
  console.log(`Source       : ${HACKS_URL}`);
  console.log(`Total records: ${summary.total}`);
  console.log("");
  console.log("--- Field completeness ---");
  console.log(`  missing name           : ${summary.missingName}`);
  console.log(`  missing date           : ${summary.missingDate}`);
  console.log(`  missing amount         : ${summary.missingAmount}`);
  console.log(`  missing technique      : ${summary.missingTechnique}`);
  console.log(`  missing chain          : ${summary.missingChain}`);
  console.log(`  missing classification : ${summary.missingClassification}`);
  console.log(`  missing source link    : ${summary.missingSource}`);
  console.log(
    `  large hacks (>= $${LARGE_HACK_THRESHOLD.toLocaleString()}) missing returnedFunds: ${
      summary.largeHacksMissingReturnedFunds
    }`
  );

  const knownAliases = findKnownAliases(hacks);
  if (knownAliases.length > 0) {
    console.log("");
    console.log("--- Known-typo technique values (auto-fixed by normalizeHacks) ---");
    for (const e of knownAliases) {
      console.log(`  [${e.name}] "${e.technique}" -> "${e.canonical}"`);
    }
  }

  const nearDupes = findNearDuplicateTechniques(hacks);
  if (nearDupes.length > 0) {
    console.log("");
    console.log("--- Near-duplicate technique values (candidates for manual consolidation) ---");
    for (const d of nearDupes) {
      console.log(
        `  "${d.variant}" (${d.variantCount}) ~ "${d.canonical}" (${d.canonicalCount})`
      );
    }
  }

  const overReturned = findReturnedFundsExceedsAmount(hacks);
  if (overReturned.length > 0) {
    console.log("");
    console.log("--- returnedFunds > amount (verify) ---");
    for (const e of overReturned) {
      console.log(
        `  ${e.name}: amount=$${(e.amount ?? 0).toLocaleString()}, returned=$${(e.returnedFunds ?? 0).toLocaleString()}, diff=+$${e.diff.toLocaleString()}`
      );
    }
  }

  const badDates = hacks.filter(
    (h) => !isPresent(h.date) || !Number.isFinite(h.date as number)
  );
  if (badDates.length > 0) {
    console.log("");
    console.log("--- Records with invalid date ---");
    for (const h of badDates) {
      console.log(`  ${h.name}: date=${JSON.stringify(h.date)}`);
    }
  }

  console.log("");
}

function printJsonReport(hacks: Hack[]) {
  const out = {
    source: HACKS_URL,
    generatedAt: new Date().toISOString(),
    summary: summarize(hacks),
    knownTypoTechniques: findKnownAliases(hacks),
    nearDuplicateTechniques: findNearDuplicateTechniques(hacks),
    returnedExceedsAmount: findReturnedFundsExceedsAmount(hacks),
    invalidDateRecords: hacks
      .filter((h) => !isPresent(h.date) || !Number.isFinite(h.date as number))
      .map((h) => ({ name: h.name, date: h.date })),
  };
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const { data } = await axios.get<Hack[]>(HACKS_URL);
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected response shape from ${HACKS_URL}`);
  }
  if (process.argv.includes("--json")) {
    printJsonReport(data);
  } else {
    printTextReport(data);
  }
}

main().catch((err) => {
  console.error("auditHacks failed:", err);
  process.exit(1);
});
