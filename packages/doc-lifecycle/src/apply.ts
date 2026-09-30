// Builds the normalised copy from decisions a reader made.
//
// It refuses any field the decision does not justify. The derivation stage
// proves what it can, a reader decides the rest, and this stage is the only one
// whose output becomes a file -- so the boundary between proof and judgement
// stays visible in the output rather than being blurred by a helpful default.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "./exposure.js";
import type {
  ApplyResult,
  Decision,
  Dossier,
  RejectedDecision,
  SpecConfig,
  WrittenDocument,
} from "./types.js";

const stemOf = (path: string): string =>
  path
    .split("/")
    .pop()!
    .replace(/\.(sot|page)\.md$/, "")
    .replace(/\.md$/, "");

// The fields the normalised header holds. The reference field and its aliases
// come from the configuration rather than a literal, because a repository that
// renamed its reference field had that field read into declared.references and
// then written out a second time as unrecognised leftovers.
export function knownFields(config: SpecConfig): Set<string> {
  return new Set([
    "kind",
    "id",
    "domain",
    "status",
    "created",
    "updated",
    "reviewed",
    "supersedes",
    "supersededBy",
    "source",
    "title",
    config.referenceField,
    ...(config.referenceAliases ?? []),
    ...(config.preservedFields ?? []),
  ]);
}

// The original lines of one frontmatter field: the key line and its indented
// continuation. Copied rather than re-serialised, because a value such as a
// shell command survives parsing only if nothing re-quotes it.
export function rawFieldLines(text: string, field: string): string[] {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!block) return [];
  const lines = block.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (start === -1) return [];
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "" || /^[A-Za-z_]/.test(line)) break;
    out.push(line);
  }
  return out;
}

export type ApplyInput = {
  repoRoot: string;
  config: SpecConfig;
  dossiers: readonly Dossier[];
  decisions: readonly Decision[];
};

export function applyDecisions({ repoRoot, config, dossiers, decisions }: ApplyInput): ApplyResult {
  const bySource = new Map(dossiers.map((d) => [d.source, d]));
  const rejected: RejectedDecision[] = [];
  const written: WrittenDocument[] = [];

  // A rename changes an id, and a relation written against the old name points
  // at nothing afterwards. Every decision's destination is known before any file
  // is built, so relations are repointed here rather than left for a reader to
  // notice as a broken link.
  const finalId = new Map<string, string>();
  for (const decision of decisions) {
    const dossier = bySource.get(decision.source);
    if (!dossier) continue;
    finalId.set(stemOf(decision.source), stemOf(decision.path ?? dossier.proposedPath));
  }

  const repoint = (values: string[] | undefined): string[] | undefined =>
    Array.isArray(values) ? values.map((v) => finalId.get(v) ?? v) : values;

  for (const original of decisions) {
    const dossier = bySource.get(original.source);
    if (!dossier) {
      rejected.push({ source: original.source, why: "no dossier: this document was not derived" });
      continue;
    }

    const decision: Decision = {
      ...original,
      supersedes: repoint(original.supersedes),
      supersededBy: repoint(original.supersededBy),
      // A reference the source declared and the decision did not restate is
      // still a reference, and the rename retired the name it was written
      // against. Repointing only what a decision restated left those pointing at
      // a name nothing answers to.
      references: repoint(original.references ?? dossier.declared.references),
    };

    // The kind a decision corrects to is the one whose vocabulary applies.
    const spec = config.kinds[decision.kind ?? dossier.derived.kind] ?? config.kinds[dossier.derived.kind];
    if (!spec) {
      rejected.push({
        source: decision.source,
        why: `kind "${decision.kind ?? dossier.derived.kind}" is not a kind this configuration declares`,
      });
      continue;
    }

    // A decision that reports no evidence is a guess wearing a decision's clothes.
    if (!decision.evidence || String(decision.evidence).trim().length < 8) {
      rejected.push({ source: decision.source, why: "no evidence recorded for the judgement" });
      continue;
    }
    if (decision.status && !spec.status.includes(decision.status)) {
      rejected.push({
        source: decision.source,
        why: `status "${decision.status}" is outside the vocabulary`,
      });
      continue;
    }
    if (decision.status === "superseded" && !(decision.supersededBy ?? []).length) {
      rejected.push({ source: decision.source, why: "superseded without naming a successor" });
      continue;
    }

    let text = "";
    try {
      text = readFileSync(join(repoRoot, decision.source), "utf8");
    } catch {
      rejected.push({ source: decision.source, why: "source file could not be read" });
      continue;
    }
    // A decision read a document as it was. Applied to a later edit, it writes
    // a judgement nobody made about the text now there.
    if (dossier.sourceSha256 && dossier.sourceSha256 !== sha256(text)) {
      rejected.push({ source: decision.source, why: "source changed since it was derived: derive again" });
      continue;
    }

    const d = dossier.derived;
    // The reading pass can correct the kind. A document's location said plan
    // because it sat under plan/, and an adr/ subdirectory full of accepted
    // decisions is not that; the derivation could only report where it sits.
    const kind = decision.kind ?? d.kind;
    // The id is the filename stem, so a decision that renames the file renames
    // the id with it. Writing the old id under a new name is the one thing this
    // layout cannot survive: a link would resolve to a file that does not exist.
    const outPath = decision.path ?? dossier.proposedPath;
    const header = ["---", `kind: ${kind}`, `id: ${stemOf(outPath)}`];
    // A derived value stands in for a declared one only where the author said
    // nothing: history dates a commit, and a declared date may say otherwise.
    const declared = (field: string): boolean =>
      (config.preservedFields ?? []).includes(field) && rawFieldLines(text, field).length > 0;
    if (d.domain && !declared("domain")) header.push(`domain: ${d.domain}`);
    header.push(`status: ${decision.status ?? ""}`);
    if (d.created && !declared("created")) header.push(`created: "${d.created}"`);
    if (d.updated && !declared("updated")) header.push(`updated: "${d.updated}"`);
    // Left empty on purpose: migrating a document is not reviewing it.
    header.push("reviewed:");
    for (const [field, values] of [
      ["supersedes", decision.supersedes],
      ["supersededBy", decision.supersededBy],
      [config.referenceField, decision.references ?? dossier.declared.references],
    ] as const) {
      if (!values || values.length === 0) continue;
      header.push(`${field}:`);
      for (const v of values) header.push(`  - ${v}`);
    }
    // Fields a kind requires that no derivation can produce -- a page's route
    // and the file it is implemented by are read off the document, not the tree.
    for (const [field, value] of Object.entries(decision.frontmatter ?? {})) {
      if (value === null || value === undefined || value === "") continue;
      if (Array.isArray(value)) {
        header.push(`${field}:`);
        for (const v of value) header.push(`  - ${v}`);
      } else header.push(`${field}: ${value}`);
    }
    const headerKeys = new Set(header.map((line) => line.split(":")[0]));
    for (const field of config.preservedFields ?? []) {
      if (headerKeys.has(field)) continue;
      header.push(...rawFieldLines(text, field));
    }
    header.push(`source: ${decision.source}`);
    // The reason the status was chosen belongs with the status. Keeping it only
    // in the decisions file leaves a reader looking at "archived" with no way to
    // tell an argued judgement from a guess, which is the failure this pipeline
    // exists to avoid.
    const reason = String(decision.evidence).replace(/\s+/g, " ").trim();
    header.push("decided_because: >-");
    for (const line of reason.match(/.{1,96}(\s|$)/g) ?? [reason]) header.push(`  ${line.trim()}`);
    header.push("---");

    // The body crosses unchanged. Only strip a leading block that actually
    // parsed as frontmatter; otherwise the document opens with a horizontal rule
    // and the body starts at the top.
    const hadFrontmatter = Object.keys(dossier.originalFrontmatter ?? {}).length > 0;
    const body = hadFrontmatter ? text.replace(/^---\n[\s\S]*?\n---\n?/, "") : text;
    const carried: string[] = [];
    const freeText = dossier.unknown.find(
      (u) => u.field === "status" && u.why.startsWith("free text"),
    );
    if (!dossier.declared.status && freeText) {
      carried.push(`\n## Carried from the original header\n\n- ${freeText.why}\n`);
    }

    // Anything else the author wrote is still theirs: dropping it during a
    // migration is the compression this pipeline exists to avoid.
    const known = knownFields(config);
    const leftover = Object.entries(dossier.originalFrontmatter ?? {}).filter(([k]) => !known.has(k));
    if (leftover.length > 0) {
      const lines = leftover.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      carried.push(`\n## Carried from the original frontmatter\n\n${lines.join("\n")}\n`);
    }

    written.push({
      from: decision.source,
      to: outPath,
      text: `${header.join("\n")}\n${body}${carried.join("")}`,
    });
  }

  return { written, rejected };
}
