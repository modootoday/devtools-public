// Every other test in this package exercises src/. What ships is dist/, and the
// thing worth proving there is the exit code: a checker that reports and always
// exits 0 reads in a hook config exactly like one that gates.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli/check.js", import.meta.url));
const describeBuilt = existsSync(cli) ? describe : describe.skip;

describeBuilt("the built checker", () => {
  let repo: string;
  const run = (...argv: string[]): { status: number; stdout: string; stderr: string } => {
    const out = spawnSync(process.execPath, [cli, ".", ...argv], { cwd: repo, encoding: "utf8" });
    return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "doc-lifecycle-built-"));
    writeFileSync(
      join(repo, "spec-conformance.json"),
      JSON.stringify({ root: ".", kinds: { plan: { dir: "plans" } } }),
    );
    mkdirSync(join(repo, "plans"), { recursive: true });
    // No header at all, so NO_FRONTMATTER and NEVER_REVIEWED both fire.
    writeFileSync(join(repo, "plans", "20260101000000-bare.md"), "# Bare\n");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reports and exits zero by default", () => {
    const out = run("--all");
    expect(out.stdout).toContain("NO_FRONTMATTER");
    expect(out.status).toBe(0);
  });

  it("exits non-zero on a code it was told to block", () => {
    expect(run("--fail-on", "NO_FRONTMATTER").status).toBe(1);
  });

  it("exits zero when the blocked code did not fire", () => {
    expect(run("--fail-on", "ID_DUPLICATE").status).toBe(0);
  });

  it("writes the whole of a report larger than a pipe buffer before exiting", () => {
    const many = mkdtempSync(join(tmpdir(), "doc-lifecycle-built-many-"));
    writeFileSync(join(many, "spec-conformance.json"), JSON.stringify({ root: ".", kinds: { plan: { dir: "plans" } } }));
    mkdirSync(join(many, "plans"), { recursive: true });
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(join(many, "plans", `20260101${String(i).padStart(6, "0")}-bare.md`), "# Bare\n");
    }
    const out = spawnSync(process.execPath, [cli, ".", "--json", "--all"], { cwd: many, encoding: "utf8" });
    rmSync(many, { recursive: true, force: true });
    expect(out.stdout.length).toBeGreaterThan(65_536);
    expect(JSON.parse(out.stdout).findings.length).toBeGreaterThanOrEqual(600);
  });

  it("refuses a code it cannot emit rather than gating on nothing", () => {
    const out = run("--fail-on", "NOT_A_CODE");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("cannot emit");
  });
});
