import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkDocuments } from "../src/check.js";
import { loadConfig } from "../src/config.js";
import { shipsInTarball } from "../src/exposure.js";
import { nextDecisionIds } from "../src/next-id.js";
import { scan } from "../src/scan.js";

const repoWith = (files: Record<string, string>): string => {
  const repo = mkdtempSync(join(tmpdir(), "doc-lifecycle-exposure-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(repo, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  return repo;
};

const plan = "---\nstatus: active\n---\n\n# A plan\n";
const exposure = (repo: string) =>
  checkDocuments(repo, loadConfig(repo)).findings.filter(
    (f) => f.code === "PUBLISHED_ROOT" || f.code === "VISIBILITY_STALE",
  );

describe("a spec root on a public path", () => {
  it("refuses a discovered root under a configured public path", () => {
    const repo = repoWith({
      "spec-conformance.json": JSON.stringify({ publicPaths: ["app/mcp"] }),
      "app/mcp/server/.spec/plans/20260924000000-a.md": plan,
      "app/private/.spec/plans/20260924000000-b.md": plan,
    });
    expect(exposure(repo).map((f) => f.path)).toEqual(["app/mcp/server/.spec"]);
  });

  it("refuses a root under docs/ even when it was discovered rather than configured", () => {
    const repo = repoWith({ "docs/guide/.spec/plans/20260924000000-a.md": plan });
    expect(exposure(repo).map((f) => f.path)).toEqual(["docs/guide/.spec"]);
  });

  it("refuses a root beside a publishable manifest with no files list", () => {
    const repo = repoWith({
      "packages/cli/package.json": JSON.stringify({ name: "cli" }),
      "packages/cli/.spec/plans/20260924000000-a.md": plan,
      "packages/app/package.json": JSON.stringify({ name: "app", private: true }),
      "packages/app/.spec/plans/20260924000000-b.md": plan,
    });
    expect(exposure(repo).map((f) => f.path)).toEqual(["packages/cli/.spec"]);
  });
});

describe("what npm ships", () => {
  it("ships everything when files is absent", () => expect(shipsInTarball({}, ".spec")).toBe(true));
  it("ships nothing from a private package", () =>
    expect(shipsInTarball({ private: true }, ".spec")).toBe(false));
  it("leaves the root out when files names only dist", () =>
    expect(shipsInTarball({ files: ["dist", "README.md"] }, ".spec")).toBe(false));
  it("ships the root when files names it", () => expect(shipsInTarball({ files: [".spec"] }, ".spec")).toBe(true));
  it("ships the root when files names the whole directory", () =>
    expect(shipsInTarball({ files: ["."] }, ".spec")).toBe(true));
  it("honours a negation over a broad entry", () =>
    expect(shipsInTarball({ files: [".", "!.spec"] }, ".spec")).toBe(false));
});

describe("public submodules, read from a committed manifest", () => {
  const gitmodules = '[submodule "vendor/open"]\n\tpath = vendor/open\n\turl = https://github.com/o/open.git\n';
  const sha = createHash("sha256").update(gitmodules).digest("hex");
  const manifest = (digest: string) =>
    JSON.stringify({
      gitmodulesSha256: digest,
      measuredAt: "2026-09-24T00:00:00Z",
      submodules: { "vendor/open": { url: "https://github.com/o/open.git", visibility: "PUBLIC" } },
    });

  it("refuses a root inside a public submodule", () => {
    const repo = repoWith({
      ".gitmodules": gitmodules,
      "visibility.json": manifest(sha),
      "spec-conformance.json": JSON.stringify({ visibilityManifest: "visibility.json" }),
      "vendor/open/.spec/plans/20260924000000-a.md": plan,
    });
    expect(exposure(repo).map((f) => `${f.code} ${f.path}`)).toEqual(["PUBLISHED_ROOT vendor/open/.spec"]);
  });

  it("reports a manifest older than .gitmodules instead of trusting it", () => {
    const repo = repoWith({
      ".gitmodules": gitmodules,
      "visibility.json": manifest("0".repeat(64)),
      "spec-conformance.json": JSON.stringify({ visibilityManifest: "visibility.json" }),
    });
    expect(exposure(repo).map((f) => f.code)).toEqual(["VISIBILITY_STALE"]);
  });

  it("reports a configured manifest that does not exist", () => {
    const repo = repoWith({
      ".gitmodules": gitmodules,
      "spec-conformance.json": JSON.stringify({ visibilityManifest: "visibility.json" }),
    });
    expect(exposure(repo).map((f) => f.code)).toEqual(["VISIBILITY_STALE"]);
  });

  it("reads nothing about submodules when no manifest is configured", () => {
    const repo = repoWith({ ".gitmodules": gitmodules, "vendor/open/.spec/plans/20260924000000-a.md": plan });
    expect(exposure(repo)).toEqual([]);
  });
});

describe("where roots are found", () => {
  it("finds a root seven directories down", () => {
    const repo = repoWith({ "a/b/c/d/e/f/g/.spec/plans/20260924000000-a.md": plan });
    expect(scan(repo, loadConfig(repo)).roots.map((r) => r.package)).toContain("a/b/c/d/e/f/g");
  });
});

describe("a document with no status anywhere", () => {
  const codes = (body: string): string[] => {
    const repo = repoWith({
      "spec-conformance.json": JSON.stringify({ root: "." }),
      "plans/20260924000000-a.md": body,
    });
    return checkDocuments(repo, loadConfig(repo)).findings.map((f) => f.code);
  };

  it("is reported apart from one that states its status in the body", () => {
    expect(codes("# A plan\n\nNo decision recorded.\n")).toContain("STATUS_ABSENT");
    expect(codes("# A plan\n\n> Status: design · Created 20260924\n")).not.toContain("STATUS_ABSENT");
    expect(codes("# A plan\n\n- **Status:** accepted\n")).not.toContain("STATUS_ABSENT");
  });

  it("is not reported when frontmatter carries the status", () => {
    expect(codes(plan)).not.toContain("STATUS_ABSENT");
  });
});

describe("the next decision number", () => {
  const ids = (names: string[], file: string) => {
    const repo = repoWith(
      Object.fromEntries([
        ["spec-conformance.json", JSON.stringify({ root: ".", kinds: { decision: { file } } })],
        ...names.map((n) => [`decisions/${n}`, "---\nstatus: accepted\n---\n"]),
      ]),
    );
    const config = loadConfig(repo);
    return nextDecisionIds(scan(repo, config).documents, config);
  };

  it("continues each area series and keeps its width", () => {
    const series = ids(
      ["ADR-TOOL-058-a.md", "ADR-TOOL-059-b.md", "ADR-PKG-071-c.md"],
      "^(ADR-[A-Z][A-Z0-9]*-\\d{3})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\\.md$",
    );
    expect(series).toEqual([
      { prefix: "ADR-PKG-", last: "ADR-PKG-071", next: "ADR-PKG-072" },
      { prefix: "ADR-TOOL-", last: "ADR-TOOL-059", next: "ADR-TOOL-060" },
    ]);
  });

  it("numbers MADR records from the default pattern", () => {
    const series = ids(["0001-a.md", "0009-b.md"], "^(\\d{4})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\\.md$");
    expect(series).toEqual([{ prefix: "", last: "0009", next: "0010" }]);
  });
});
