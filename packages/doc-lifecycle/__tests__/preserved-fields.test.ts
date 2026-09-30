import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyDecisions, rawFieldLines } from "../src/apply.js";
import { DEFAULTS } from "../src/config.js";
import { parseFrontmatter } from "../src/scan.js";
import type { Dossier, SpecConfig } from "../src/types.js";

const SOURCE = [
  "---",
  "sot: layout",
  "domain: arch",
  "status: canonical",
  "applies_to:",
  '  - "apps/*/app/**"',
  "  - core/**",
  "verify: every package keeps its rules beside its code",
  `check_cmd: 'test -z "$(find . -name x -printf "%p\\n")"'`,
  "owner: someone",
  'updated: "20260921075500"',
  "---",
  "",
  "# Layout",
  "",
].join("\n");

const EVIDENCE =
  "The source declares itself canonical and nothing supersedes it; its check runs green on the tree measured.";

const run = (preservedFields: string[], sourceSha256?: string) => {
  const repo = mkdtempSync(join(tmpdir(), "doc-lifecycle-preserved-"));
  mkdirSync(join(repo, "standards/arch"), { recursive: true });
  writeFileSync(join(repo, "standards/arch/layout.sot.md"), SOURCE);
  const config: SpecConfig = { ...DEFAULTS, preservedFields, source: "test" };
  const dossier = {
    source: "standards/arch/layout.sot.md",
    package: ".",
    derived: {
      kind: "sot",
      id: "layout",
      domain: "arch",
      created: null,
      updated: "20260903",
      renamedFrom: null,
      lines: 12,
      chapters: [],
    },
    declared: { status: "canonical", supersedes: [], references: [] },
    originalFrontmatter: parseFrontmatter(SOURCE)!,
    sourceSha256,
    unknown: [],
    proposedPath: ".spec/standards/arch/layout.sot.md",
  } as unknown as Dossier;
  const { written, rejected } = applyDecisions({
    repoRoot: repo,
    config,
    dossiers: [dossier],
    decisions: [{ source: "standards/arch/layout.sot.md", status: "canonical", evidence: EVIDENCE }],
  });
  return { text: written[0]?.text ?? "", rejected };
};

const applied = (preservedFields: string[]) => {
  const { text, rejected } = run(preservedFields);
  expect(rejected).toEqual([]);
  return text;
};

describe("a decision about a document that has since changed", () => {
  it("is refused", () => {
    const { rejected } = run([], createHash("sha256").update("an older text").digest("hex"));
    expect(rejected.map((r) => r.why)).toEqual(["source changed since it was derived: derive again"]);
  });

  it("is applied when the source is the one derived", () => {
    const { rejected } = run([], createHash("sha256").update(SOURCE).digest("hex"));
    expect(rejected).toEqual([]);
  });
});

describe("fields a repository's own gates read", () => {
  it("cross into the new header verbatim when preserved", () => {
    const text = applied(["applies_to", "verify", "check_cmd"]);
    const header = text.slice(0, text.indexOf("\n---\n", 3));
    expect(header).toContain('applies_to:\n  - "apps/*/app/**"\n  - core/**');
    expect(header).toContain("verify: every package keeps its rules beside its code");
    expect(header).toContain(`check_cmd: 'test -z "$(find . -name x -printf "%p\\n")"'`);
    const fm = parseFrontmatter(text)!;
    expect(fm["check_cmd"]).toBe(parseFrontmatter(SOURCE)!["check_cmd"]);
    expect(text).not.toMatch(/- (applies_to|verify|check_cmd):/);
  });

  it("are carried as prose, not fields, when nothing preserves them", () => {
    const text = applied([]);
    const header = text.slice(0, text.indexOf("\n---\n", 3));
    expect(header).not.toContain("check_cmd:");
    expect(text).toContain("## Carried from the original frontmatter");
    expect(text).toContain("- check_cmd:");
  });

  it("keep a declared date over the one history derives", () => {
    const fm = parseFrontmatter(applied(["updated"]))!;
    expect(fm["updated"]).toBe("20260921075500");
  });

  it("let history date the document when the date is not preserved", () => {
    const fm = parseFrontmatter(applied([]))!;
    expect(fm["updated"]).toBe("20260903");
  });

  it("leave a field nobody preserved in the carried section", () => {
    const text = applied(["applies_to", "verify", "check_cmd"]);
    expect(text).toContain("- owner: someone");
  });
});

describe("rawFieldLines", () => {
  it("returns the key line and its indented continuation", () => {
    expect(rawFieldLines(SOURCE, "applies_to")).toEqual(["applies_to:", '  - "apps/*/app/**"', "  - core/**"]);
  });
  it("returns nothing for a field the header does not carry", () => {
    expect(rawFieldLines(SOURCE, "absent")).toEqual([]);
  });
  it("returns nothing when there is no header", () => {
    expect(rawFieldLines("# Title\n", "status")).toEqual([]);
  });
});
