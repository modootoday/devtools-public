// Every example in .agent/skills/document-conformance/SKILL.md, run against the
// real package. A worked example that does not run is not an example.
//
// Nothing here spawns git. `buildGraph` is called without history on purpose --
// that is the option the skill tells consumers to pass -- and `loadHistory`,
// `deriveDossiers` and `discoverCandidates` are left out because their only
// behaviour in a directory with no repository is their empty branch.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULTS,
  buildGraph,
  checkDocuments,
  clusterDocuments,
  graphView,
  loadConfig,
  namedPaths,
  parseFrontmatter,
  renderMermaid,
  scan,
} from "../src/index.js";

const NOW = Date.UTC(2026, 5, 1);

const write = (root: string, rel: string, text: string): void => {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

// Two decisions: one conforming, one that has not decided its status and has
// never been reviewed.
let decisionsRoot: string;
// Six plans: four naming one subject, two naming another, plus one wikilink
// that resolves and one that does not.
let plansRoot: string;
// The fixture the skill's Testing section shows verbatim.
let cleanRoot: string;

beforeAll(() => {
  decisionsRoot = mkdtempSync(join(tmpdir(), "docs-decisions-"));
  write(
    decisionsRoot,
    ".spec/decisions/0001-adopt-the-checker.md",
    "---\nkind: decision\nid: 0001-adopt-the-checker\nstatus: accepted\nreviewed: 20260101\n---\n\n# Adopt\n",
  );
  write(
    decisionsRoot,
    ".spec/decisions/0002-second-thoughts.md",
    "---\nkind: decision\nstatus: pondering\n---\n\n# Second thoughts\n",
  );

  plansRoot = mkdtempSync(join(tmpdir(), "docs-plans-"));
  const plan = (id: string, title: string, body = ""): string =>
    `---\nkind: plan\nid: ${id}\nstatus: active\n---\n\n# ${title}\n\n${body}\n`;
  write(
    plansRoot,
    ".spec/plans/20260101000000-billing-retries.md",
    plan(
      "20260101000000-billing-retries",
      "Billing retries",
      "See [[20260102000000-billing-webhooks]] and [[nope]].",
    ),
  );
  write(
    plansRoot,
    ".spec/plans/20260102000000-billing-webhooks.md",
    plan("20260102000000-billing-webhooks", "Billing webhooks"),
  );
  write(
    plansRoot,
    ".spec/plans/20260103000000-billing-refunds.md",
    plan("20260103000000-billing-refunds", "Billing refunds"),
  );
  write(
    plansRoot,
    ".spec/plans/20260104000000-billing-invoices.md",
    plan("20260104000000-billing-invoices", "Billing invoices"),
  );
  write(
    plansRoot,
    ".spec/plans/20260105000000-search-ranking.md",
    plan("20260105000000-search-ranking", "Search ranking"),
  );
  write(
    plansRoot,
    ".spec/plans/20260106000000-search-indexing.md",
    plan("20260106000000-search-indexing", "Search indexing"),
  );

  cleanRoot = mkdtempSync(join(tmpdir(), "docs-clean-"));
  write(
    cleanRoot,
    ".spec/decisions/0001-adopt-the-checker.md",
    "---\nkind: decision\nid: 0001-adopt-the-checker\nstatus: accepted\nreviewed: 20260101\n---\n\n# Adopt\n",
  );
});

afterAll(() => {
  for (const root of [decisionsRoot, plansRoot, cleanRoot]) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SKILL.md — Install and wire", () => {
  it("scans the tree and returns documents beside findings", () => {
    const config = loadConfig(decisionsRoot);
    const { documents, findings } = checkDocuments(decisionsRoot, config, { now: NOW });

    expect(config.source).toBe("defaults");
    expect(documents.map((doc) => doc.id).sort()).toEqual([
      "0001-adopt-the-checker",
      "0002-second-thoughts",
    ]);
    // Every finding carries the three fields the snippet prints.
    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual(["code", "detail", "path"]);
    }
  });
});

describe("SKILL.md — worked example 1, checking and the gate", () => {
  const BLOCKING = new Set(["ID_DUPLICATE", "STATUS_UNKNOWN", "IMPLEMENTS_MISSING"]);

  function gate(repoRoot: string): number {
    const config = loadConfig(repoRoot);
    const { findings } = checkDocuments(repoRoot, config, { now: NOW });
    return findings.some((finding) => BLOCKING.has(finding.code)) ? 1 : 0;
  }

  it("reports exactly the two codes the skill names", () => {
    const { findings } = checkDocuments(decisionsRoot, loadConfig(decisionsRoot), { now: NOW });
    expect(findings.map((finding) => finding.code).sort()).toEqual([
      "NEVER_REVIEWED",
      "STATUS_UNKNOWN",
    ]);
    // The unreviewed document is the one that carries both.
    expect(new Set(findings.map((finding) => finding.path)).size).toBe(1);
  });

  it("blocks on the named code and would not have blocked on the other", () => {
    expect(gate(decisionsRoot)).toBe(1);
    expect(gate(cleanRoot)).toBe(0);
  });
});

describe("SKILL.md — worked example 2, which document is current", () => {
  function subjects(repoRoot: string) {
    const config = loadConfig(repoRoot);
    const { documents } = scan(repoRoot, config);
    const policy = { ...DEFAULTS.cluster, minDocuments: 3, maxDocumentFrequency: 0.9 };
    return clusterDocuments(documents, policy, { minDocuments: 3 });
  }

  it("returns one cluster nobody can resolve", () => {
    const clusters = subjects(plansRoot);
    expect(clusters.map((cluster) => cluster.subject)).toEqual(["billing"]);

    const billing = clusters[0]!;
    expect(billing.documents).toBe(4);
    expect(billing.withStatus).toBe(4);
    expect(billing.withSupersede).toBe(0);
    expect(billing.answerable).toBe(false);
    expect(billing.members).toHaveLength(4);
  });

  it("shows why the frequency ceiling has to be raised on a small set", () => {
    const { documents } = scan(plansRoot, loadConfig(plansRoot));
    const withDefaultCeiling = clusterDocuments(documents, DEFAULTS.cluster, {
      minDocuments: 3,
    });
    // 4 of 6 documents is far over the 15% default, so the subject is dropped.
    expect(withDefaultCeiling.map((cluster) => cluster.subject)).not.toContain("billing");
  });
});

describe("SKILL.md — worked example 3, the three frontmatter parses", () => {
  it("parses two rules around prose to an object with no keys, not null", () => {
    const rules = parseFrontmatter("---\n\nJust prose, not a header.\n\n---\n\n# Title\n");
    expect(rules).not.toBeNull();
    expect(Object.keys(rules!)).toEqual([]);
    const isHeader = rules !== null && Object.keys(rules).length > 0;
    expect(isHeader).toBe(false);
  });

  it("parses an inline empty list as a list", () => {
    const empty = parseFrontmatter("---\nsupersedes: []\n---\n");
    expect(empty?.supersedes).toEqual([]);
    expect(empty?.supersedes).not.toBe("[]");
  });

  it("parses a blank value as an empty string, not an empty list", () => {
    const blank = parseFrontmatter("---\nstatus:\n---\n");
    expect(blank?.status).toBe("");
    expect(Array.isArray(blank?.status)).toBe(false);
  });
});

describe("SKILL.md — worked example 4, the graph", () => {
  function report(repoRoot: string) {
    const config = loadConfig(repoRoot);
    const { documents } = scan(repoRoot, config);
    const graph = buildGraph(documents, config);
    const dangling = graph.findings.filter((finding) => finding.code === "LINK_DANGLING");
    const picture = renderMermaid(graphView(graph, config, "orphans"));
    return { dangling, graph, picture };
  }

  it("finds the link that resolves to nothing and none of the ones that resolve", () => {
    const { dangling, graph } = report(plansRoot);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.detail).toContain("[[nope]]");
    expect(graph.edges.filter((edge) => edge.type === "link")).toHaveLength(1);
  });

  it("spawns nothing, so there are no commit edges without an explicit history", () => {
    const { graph } = report(plansRoot);
    expect(graph.commitEdges).toEqual([]);
  });

  it("renders the orphans view as mermaid text", () => {
    const { picture } = report(plansRoot);
    expect(picture.split("\n")[1]).toBe("graph TD");
    // Two of the six plans are joined by the link; the other four are orphans.
    expect(picture).toContain("orphans: 4 nodes, 0 edges");
  });

  it("filters named paths by pathRoots, and keeps everything when it is empty", () => {
    const text = "touches `src/check.ts` and `build/out.js`";
    expect(namedPaths(text, ["src"])).toEqual(["src/check.ts"]);
    expect(namedPaths(text, [])).toEqual(["src/check.ts", "build/out.js"]);
  });
});

describe("SKILL.md — Testing against it, the fixture shown verbatim", () => {
  it("reports nothing about a conforming decision", () => {
    const { findings } = checkDocuments(cleanRoot, loadConfig(cleanRoot), { now: NOW });
    expect(findings).toEqual([]);
  });

  it("asserts codes rather than detail strings", () => {
    const { findings } = checkDocuments(decisionsRoot, loadConfig(decisionsRoot), { now: NOW });
    const codes = findings.map((finding) => finding.code).sort();
    expect(codes).toEqual(["NEVER_REVIEWED", "STATUS_UNKNOWN"]);
  });
});
