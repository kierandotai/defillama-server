// Helpers for normalizing and validating hack records as they come out of
// Airtable. Only obvious, zero-ambiguity fixes (whitespace, known typos) are
// applied here; judgment-call normalizations (e.g. unifying "Reentrancy" with
// "Re-entrancy Exploit") are left for the maintainers to decide on in the
// source data.

export function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

// Exact-match aliases for technique values that are unambiguously the same
// thing as their canonical form. Keep this list conservative: each entry
// should be a typo or trivial variant, not a semantic judgment call.
export const TECHNIQUE_ALIASES: Record<string, string> = {
  "Acces Control Exploit": "Access Control Exploit",
};

export function normalizeTechnique(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (cleaned === null) return null;
  return TECHNIQUE_ALIASES[cleaned] ?? cleaned;
}

export function normalizeChain(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  const items = Array.isArray(value) ? value : [value];
  const cleaned = items
    .map((item) => cleanString(item))
    .filter((item): item is string => item !== null);
  return cleaned.length > 0 ? cleaned : null;
}

// Returns a unix timestamp in seconds, or null if the input cannot be parsed
// into a real date. The previous implementation produced NaN for missing dates
// (`new Date(undefined).getTime() / 1000`), which then propagated into the
// API response and the downstream sort/test code.
export function parseHackDate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value as string | number).getTime();
  if (!Number.isFinite(parsed)) return null;
  return parsed / 1000;
}

export function normalizeAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}
