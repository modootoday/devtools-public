import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { knownFields } from "../src/apply.js";
import { checkDocuments } from "../src/check.js";
import { exitCodeFor, failingCodes, unknownCodes } from "../src/cli/args.js";
import { DEFAULTS, loadConfig, specDir, workDir } from "../src/config.js";
import { CHECK_CODES } from "../src/types.js";
import type { Finding, SpecConfig } from "../src/types.js";

const finding = (code: string): Finding => ({ code, path: "x.md", detail: "d" });

describe("which findings block", () => {
  // Reporting stays the default: a document set with findings is the normal
  // starting state of a migration, not the tool's failure. Before this the last
  // line was an unconditional exit 0, so the checker could not gate anything.
  it("blocks nothing when nothing is named", () => {
    expect(exitCodeFor([finding("NO_FRONTMATTER")], failingCodes(null))).toBe(0);
    expect(exitCodeFor([finding("NO_FRONTMATTER")], failingCodes(""))).toBe(0);
  });

  it("blocks on any finding when asked for any", () => {
    expect(exitCodeFor([finding("NO_FRONTMATTER")], failingCodes("any"))).toBe(1);
    expect(exitCodeFor([], failingCodes("any"))).toBe(0);
  });

  it("blocks only on the codes named", () => {
    const gate = failingCodes("id_duplicate, published_root");
    expect(exitCodeFor([finding("NO_FRONTMATTER")], gate)).toBe(0);
    expect(exitCodeFor([finding("ID_DUPLICATE")], gate)).toBe(1);
  });

  // A gate on a code the checker cannot emit is a gate that never fires, and it
  // reads in a hook config exactly like one that does.
  it("names a code the checker cannot emit", () => {
    expect(unknownCodes(failingCodes("ID_DUPLICATE,TYPO"), CHECK_CODES)).toEqual(["TYPO"]);
    expect(unknownCodes(failingCodes("any"), CHECK_CODES)).toEqual([]);
  });
});

describe("the review cadence a kind declares", () => {
  let repo: string;
  const day = 86_400_000;
  const now = Date.parse("2026-09-06T00:00:00Z");

  const write = (rel: string, body: string): void => {
    mkdirSync(join(repo, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "doc-lifecycle-review-"));
    writeFileSync(
      join(repo, "spec-conformance.json"),
      JSON.stringify({ root: ".", kinds: { plan: { dir: "plans" } } }),
    );
    // reviewEveryDays is 90 for a plan. One document is inside that window and
    // one is outside it; before this the field was configuration nothing read,
    // so a document reviewed once counted as reviewed forever.
    write(
      "plans/20260101000000-fresh.md",
      '---\nstatus: active\nreviewed: "20260801"\n---\n\n# Fresh\n',
    );
    write(
      "plans/20260101000000-stale.md",
      '---\nstatus: active\nreviewed: "20260101"\n---\n\n# Stale\n',
    );
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reports only the document past its cadence", () => {
    const { findings } = checkDocuments(repo, loadConfig(repo), { now });
    const overdue = findings.filter((f) => f.code === "REVIEW_OVERDUE");
    expect(overdue).toHaveLength(1);
    expect(overdue[0].path).toBe("plans/20260101000000-stale.md");
    expect(overdue[0].detail).toBe("last reviewed 248 days ago; plan is reviewed every 90");
  });

  it("reports nothing when the cadence has not yet elapsed", () => {
    const { findings } = checkDocuments(repo, loadConfig(repo), { now: now - 200 * day });
    expect(findings.filter((f) => f.code === "REVIEW_OVERDUE")).toEqual([]);
  });
});

describe("the fields a normalised header is allowed to absorb", () => {
  const config = (over: Partial<SpecConfig>): SpecConfig => ({ ...DEFAULTS, source: "t", ...over });

  // The reference field and its aliases were literals here while the aliases
  // themselves were configurable, so a repository that renamed its reference
  // field had that field read into declared.references and then written out a
  // second time as unrecognised leftovers.
  it("takes the reference field and every alias from the configuration", () => {
    const known = knownFields(config({ referenceField: "points_at", referenceAliases: ["cites"] }));
    expect(known.has("points_at")).toBe(true);
    expect(known.has("cites")).toBe(true);
    expect(known.has("references")).toBe(false);
  });

  it("covers the aliases the defaults declare", () => {
    const known = knownFields(config({}));
    for (const alias of DEFAULTS.referenceAliases) expect(known.has(alias)).toBe(true);
  });
});

describe("where a migration puts what it produces", () => {
  // Deriving this from the configured root rather than naming .spec keeps a
  // repository that chose another root from growing a second one.
  it("follows the configured root", () => {
    expect(specDir({ ...DEFAULTS, source: "t", root: ".design" })).toBe(".design");
    expect(workDir({ ...DEFAULTS, source: "t", root: ".design" })).toBe(join(".design", "_work"));
  });

  // A repository whose documents are still a top-level pile is scanned at ".",
  // and its destination is a spec root that does not exist yet. Reading "." as
  // the destination writes the normalised copies back into the pile.
  it("falls back to the default root when the pile is the repository itself", () => {
    expect(specDir({ ...DEFAULTS, source: "t", root: "." })).toBe(DEFAULTS.root);
    expect(workDir({ ...DEFAULTS, source: "t", root: "." })).toBe(join(".spec", "_work"));
  });
});
