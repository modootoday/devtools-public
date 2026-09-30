import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { buildGraph } from "../src/graph.js";
import { scan } from "../src/scan.js";
import type { SpecConfig } from "../src/types.js";

const PLANS: Record<string, string> = {
  "20260101000000-old.md": "---\nstatus: active\n---\n\n# Old\n",
  "20260102000000-annotated.md":
    '---\nstatus: active\nsupersedes:\n  - "drafts/20260101000000-old.md (initial scaffold)"\n---\n\n# Annotated\n',
  "20260103000000-stamped.md": '---\nstatus: active\nsupersedes:\n  - "drafts/20260101000000 §4"\n---\n\n# Stamped\n',
  "20260104000000-absent.md": "---\nstatus: active\nsupersedes:\n  - nothing-by-this-name\n---\n\n# Absent\n",
};

const graphOf = (fileExists?: (path: string) => boolean) => {
  const repo = mkdtempSync(join(tmpdir(), "doc-lifecycle-relations-"));
  mkdirSync(join(repo, ".spec/plans"), { recursive: true });
  for (const [name, body] of Object.entries(PLANS)) writeFileSync(join(repo, ".spec/plans", name), body);
  const config: SpecConfig = { ...DEFAULTS, source: "test" };
  const { documents } = scan(repo, config);
  return buildGraph(documents, config, fileExists ? { fileExists } : {});
};

PLANS["20260105000000-retired.md"] =
  "---\nstatus: active\nsupersedes:\n  - .agent/rules/OLD_RULE.md\n  - .agent/rules/GONE.md\n---\n\n# Retired\n";

describe("a supersedes entry naming a retired file", () => {
  const dangling = (fileExists?: (path: string) => boolean) =>
    graphOf(fileExists)
      .findings.filter((f) => f.code === "SUPERSEDE_DANGLING" && f.path.includes("retired"))
      .map((f) => f.detail);

  it("resolves when the file still stands in the repository as a stub", () => {
    expect(dangling((p) => p === ".agent/rules/OLD_RULE.md")).toEqual([
      'supersedes ".agent/rules/GONE.md" resolves to nothing',
    ]);
  });

  it("dangles when nobody says whether the file exists", () => {
    expect(dangling()).toHaveLength(2);
  });
});

describe("a supersedes entry written as a path", () => {
  const { edges, findings } = graphOf();
  const supersedes = (from: string) =>
    edges.filter((e) => e.type === "supersedes" && e.from.id === from).map((e) => e.to.id);

  it("resolves through its annotation and extension", () => {
    expect(supersedes("20260102000000-annotated")).toEqual(["20260101000000-old"]);
  });

  it("resolves a plan cited by its timestamp alone", () => {
    expect(supersedes("20260103000000-stamped")).toEqual(["20260101000000-old"]);
  });

  it("still dangles when nothing answers to it", () => {
    const dangling = findings
      .filter((f) => f.code === "SUPERSEDE_DANGLING" && !f.path.includes("retired"))
      .map((f) => f.path);
    expect(dangling).toEqual([".spec/plans/20260104000000-absent.md"]);
  });
});
