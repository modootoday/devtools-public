// A synthetic repository with fixed commit dates, so the window logic is
// decided by history rather than by how fast the test ran. Every document here
// is a defect that actually happened once.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyDecisions } from "../src/apply.js";
import { checkDocuments } from "../src/check.js";
import { loadConfig } from "../src/config.js";
import { deriveDossiers } from "../src/derive.js";
import { buildGraph, loadHistory } from "../src/graph.js";
import { parseFrontmatter, scan } from "../src/scan.js";
import type { Decision, Dossier } from "../src/types.js";

const FIXTURE: Record<string, string> = {
  "spec-conformance.json": JSON.stringify(
    {
      root: ".",
      kinds: {
        plan: { dir: "plans", sourceDirs: ["drafts"] },
        sot: { dir: "standards", sourceDirs: ["sot-src"], idField: "sot", domain: ["arch"] },
      },
    },
    null,
    2,
  ),

  // References must survive code: a fenced sample and an inline span both spell
  // a TOML array-of-tables header exactly like a wikilink.
  "drafts/20260101000000-alpha.md": `---
status: active
references:
  - 20260102000000-beta
---

# Alpha

Alpha depends on [[20260102000000-beta]] and is implemented in \`src/thing.ts\`.

\`\`\`toml
[[services]]
name = "x"
\`\`\`

An inline one is not a link either: \`[[services]]\`.
`,

  // supersedes: [] once declared a supersede of a document literally named "[]".
  "drafts/20260102000000-beta.md": `---
status: active
supersedes: []
references:
  - layout
---

# Beta

Beta points at layout by the stem of the file it sits in, which is renamed below.
`,

  // Opens with a horizontal rule. Reading the pair of rules as a header once
  // deleted everything between them.
  "drafts/20260103000000-gamma.md": `---

# Gamma

This document opens with a horizontal rule, not a header.

---

## Second section

A tool that reads the pair as frontmatter deletes this section.
`,

  "drafts/20260104000000-delta.md": `---
status: active
---

# Delta

Delta names \`src/later.ts\`, a file nothing touched while this document was
still being edited. It also mentions src/never.ts without backticks.
`,

  // Addressed by an id its filename does not carry: the migration renames it.
  "sot-src/arch/layout.sot.md": `---
sot: workspace-layout
domain: arch
status: canonical
---

# Workspace Layout

Everything addresses this as [[workspace-layout]], the id it declares.
`,
};

const EVIDENCE = "Read: this document was opened and judged.";

describe("the migration pipeline, end to end", () => {
  let repo: string;
  let dossiers: Map<string, Dossier>;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "doc-lifecycle-pipeline-"));
    let gitDate = "2026-01-01T00:00:00Z";
    const git = (...argv: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...argv], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: gitDate, GIT_COMMITTER_DATE: gitDate },
      });
    };

    for (const [rel, body] of Object.entries(FIXTURE)) {
      mkdirSync(join(repo, dirname(rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "thing.ts"), "export const thing = 1;\n");

    git("init", "-q", ".");
    git("add", "-A");
    git("commit", "-qm", "feat: alpha, beta, gamma, layout");

    gitDate = "2026-01-02T00:00:00Z";
    writeFileSync(join(repo, "src", "thing.ts"), "export const thing = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "fix: touch the path alpha names");

    // A week after delta stopped being edited, so its only candidate falls
    // outside the window and the search has to widen to find anything.
    gitDate = "2026-01-10T00:00:00Z";
    writeFileSync(join(repo, "src", "later.ts"), "export const later = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "feat: add the file delta named, a week later");

    const config = loadConfig(repo);
    dossiers = new Map(deriveDossiers(repo, config).dossiers.map((d) => [d.source, d]));
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("derives every document", () => expect(dossiers.size).toBe(5));

  it("does not read a wikilink inside code as a reference", () => {
    // The frontmatter entry and the prose wikilink are the same reference once.
    expect(dossiers.get("drafts/20260101000000-alpha.md")!.declared.references).toEqual([
      "20260102000000-beta",
    ]);
  });

  it("takes a path in backticks as a candidate and a bare one as prose", () => {
    const alpha = dossiers.get("drafts/20260101000000-alpha.md")!;
    const delta = dossiers.get("drafts/20260104000000-delta.md")!;
    expect(alpha.implementation.pathCandidates.map((c) => c.token)).toEqual(["src/thing.ts"]);
    expect(delta.implementation.pathCandidates.map((c) => c.token)).toEqual(["src/later.ts"]);
  });

  // Narrow first, widen only when the narrow answer is empty, and say so.
  it("widens past an empty window and states why", () => {
    const alpha = dossiers.get("drafts/20260101000000-alpha.md")!;
    const delta = dossiers.get("drafts/20260104000000-delta.md")!;
    expect(alpha.implementation.commitSearch.scope).toBe("in-window");
    expect(delta.implementation.commitSearch.scope).toBe("widened-past-window");
    expect(delta.implementation.commitSearch.widenedBecause).toBe(
      "no commit touched the paths this document names while it was still being edited",
    );
    expect(delta.implementation.commitSearch.counts).toEqual({ inWindow: 0, afterWindow: 1 });
  });

  it("reads an inline empty list as no supersede at all", () => {
    expect(dossiers.get("drafts/20260102000000-beta.md")!.declared.supersedes).toEqual([]);
  });

  it("leaves a horizontal-rule document with no frontmatter keys and no status", () => {
    const gamma = dossiers.get("drafts/20260103000000-gamma.md")!;
    expect(Object.keys(gamma.originalFrontmatter)).toEqual([]);
    expect(gamma.declared.status).toBeNull();
  });

  it("derives the id from the filename, the domain from the directory, dates from history", () => {
    const layout = dossiers.get("sot-src/arch/layout.sot.md")!;
    expect(layout.derived.id).toBe("layout");
    expect(layout.derived.domain).toBe("arch");
    expect(layout.derived.created).toBe("20260101");
  });

  it("names the destination after the id the header declares, so links by that id resolve", () => {
    const layout = dossiers.get("sot-src/arch/layout.sot.md")!;
    expect(layout.proposedPath).toBe(".spec/standards/arch/workspace-layout.sot.md");
  });

  it("keeps the filename when the header declares no other id", () => {
    expect(dossiers.get("drafts/20260101000000-alpha.md")!.proposedPath).toBe(
      ".spec/plans/20260101000000-alpha.md",
    );
  });

  // A decision that reports no evidence is a guess wearing a decision's clothes,
  // and a decision naming a document nobody derived has nothing to apply to.
  it("refuses thin evidence and a decision with no dossier", () => {
    const config = loadConfig(repo);
    const { written, rejected } = applyDecisions({
      repoRoot: repo,
      config,
      dossiers: [...dossiers.values()],
      decisions: [
        { source: "drafts/20260101000000-alpha.md", status: "archived", evidence: "short" },
        { source: "drafts/20260101000000-absent.md", status: "archived", evidence: EVIDENCE },
      ],
    });
    expect(written).toHaveLength(0);
    expect(rejected.map((r) => r.why)).toEqual([
      "no evidence recorded for the judgement",
      "no dossier: this document was not derived",
    ]);
  });

  describe("after the decisions are applied", () => {
    beforeAll(() => {
      const config = loadConfig(repo);
      const decisions: Decision[] = [
        { source: "drafts/20260101000000-alpha.md", status: "archived", evidence: EVIDENCE },
        { source: "drafts/20260102000000-beta.md", status: "archived", evidence: EVIDENCE },
        { source: "drafts/20260103000000-gamma.md", status: "archived", evidence: EVIDENCE },
        { source: "drafts/20260104000000-delta.md", status: "archived", evidence: EVIDENCE },
        {
          source: "sot-src/arch/layout.sot.md",
          status: "canonical",
          path: ".spec/standards/arch/workspace-layout.sot.md",
          evidence: EVIDENCE,
        },
      ];
      const { written, rejected } = applyDecisions({
        repoRoot: repo,
        config,
        dossiers: [...dossiers.values()],
        decisions,
      });
      expect(rejected).toHaveLength(0);
      expect(written).toHaveLength(5);
      for (const item of written) {
        const full = join(repo, item.to);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, item.text);
      }
      writeFileSync(
        join(repo, ".spec-check.json"),
        JSON.stringify({
          root: ".spec",
          kinds: { plan: { dir: "plans" }, sot: { dir: "standards", domain: ["arch"] } },
        }),
      );
    });

    const written = (rel: string): string => readFileSync(join(repo, rel), "utf8");
    const bodyOf = (text: string): string => text.slice(text.indexOf("\n---\n", 3) + 5);

    // The regression that mattered most: a document whose opening rule is not a
    // header must arrive with every line it had.
    it("keeps a horizontal-rule document's whole body", () => {
      expect(bodyOf(written(".spec/plans/20260103000000-gamma.md"))).toBe(
        FIXTURE["drafts/20260103000000-gamma.md"],
      );
    });

    it("keeps an ordinary document's body below the header", () => {
      const source = FIXTURE["drafts/20260102000000-beta.md"];
      expect(bodyOf(written(".spec/plans/20260102000000-beta.md"))).toBe(
        source.slice(source.indexOf("\n---\n", 3) + 5),
      );
    });

    // A rename changes an id, and a relation written against the old name points
    // at nothing afterwards unless the apply stage repoints it.
    it("repoints a relation onto its target's new name", () => {
      const beta = parseFrontmatter(written(".spec/plans/20260102000000-beta.md"))!;
      expect(beta.references).toEqual(["workspace-layout"]);
      expect(beta.id).toBe("20260102000000-beta");
    });

    it("writes the destination filename as the id, with the status and the source", () => {
      const layout = parseFrontmatter(written(".spec/standards/arch/workspace-layout.sot.md"))!;
      expect(layout.id).toBe("workspace-layout");
      expect(layout.status).toBe("canonical");
      expect(layout.source).toBe("sot-src/arch/layout.sot.md");
    });

    // Reading the source tree and reading the destination are two different
    // questions, and the pile still reports what motivated the rename.
    it("still reports the id disagreement in the source pile", () => {
      const { findings } = checkDocuments(repo, loadConfig(repo));
      const disagreement = findings.find((f) => f.code === "ID_DISAGREES");
      expect(disagreement?.detail).toBe(
        'declared id "workspace-layout" is not the filename stem "layout"',
      );
      // Nobody had decided gamma's status before the reading pass, and saying so
      // is the point of the finding.
      expect(findings.some((f) => f.code === "STATUS_UNDECIDED")).toBe(true);
    });

    // Three ways to invent a broken link, all of which happened: a phantom
    // supersede from an empty list, a code path read as a document, and a
    // relation left pointing at a name the rename retired.
    it("finds nothing wrong in the normalised graph", () => {
      const config = loadConfig(repo, ".spec-check.json");
      const { documents } = scan(repo, config);
      const graph = buildGraph(documents, config, { history: loadHistory(repo) });
      expect(graph.findings).toEqual([]);
    });

    it("finds no shape or status problem in the normalised tree", () => {
      const config = loadConfig(repo, ".spec-check.json");
      expect(config.source).toBe(".spec-check.json");
      const { findings } = checkDocuments(repo, config);
      const codes = new Set(findings.map((f) => f.code));
      for (const code of ["FILENAME_SHAPE", "ID_DISAGREES", "KIND_DISAGREES", "STATUS_UNDECIDED"]) {
        expect(codes.has(code as never)).toBe(false);
      }
    });
  });
});
