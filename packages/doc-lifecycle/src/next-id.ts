// The next decision number, derived from the documents rather than remembered.
// Two sessions picking a number from memory is how two records came to share
// one; allocating from the tree makes the collision visible before the write.

import type { Document, SpecConfig } from "./types.js";

export type NextId = { prefix: string; last: string | null; next: string };

// The decision pattern's first capture group is the numbered part of the name:
// "0042" for MADR, "ADR-TOOL-059" for area-prefixed records. Its trailing digits
// are the counter and everything before them is the series.
export function nextDecisionIds(documents: readonly Document[], config: SpecConfig): NextId[] {
  const spec = config.kinds["decision"];
  if (!spec) return [];
  const pattern = new RegExp(spec.file);
  const bySeries = new Map<string, { width: number; max: number; last: string }>();

  for (const doc of documents) {
    if (doc.isChapter) continue;
    const numbered = pattern.exec(doc.filename)?.[1];
    if (!numbered) continue;
    const digits = /(\d+)$/.exec(numbered)?.[1];
    if (!digits) continue;
    const prefix = numbered.slice(0, numbered.length - digits.length);
    const value = Number(digits);
    const seen = bySeries.get(prefix);
    if (!seen || value > seen.max) {
      bySeries.set(prefix, { width: Math.max(digits.length, seen?.width ?? 0), max: value, last: numbered });
    }
  }

  return [...bySeries.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([prefix, { width, max, last }]) => ({
      prefix,
      last,
      next: `${prefix}${String(max + 1).padStart(width, "0")}`,
    }));
}
