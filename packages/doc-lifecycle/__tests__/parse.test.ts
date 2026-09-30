import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig } from "../src/config.js";
import { idOf, kindOf, parseFrontmatter, proseOnly } from "../src/scan.js";
import type { SpecConfig } from "../src/types.js";

const withDefaults = (): SpecConfig => ({ ...DEFAULTS, source: "defaults" });

describe("parseFrontmatter", () => {
  it("reads and unquotes scalar values", () => {
    expect(parseFrontmatter('---\nkind: plan\nid: "20260831000000-a"\nstatus: active\n---\nbody\n')).toEqual(
      { kind: "plan", id: "20260831000000-a", status: "active" },
    );
  });

  it("turns an indented dash list into an array", () => {
    expect(parseFrontmatter("---\nreferences:\n  - one\n  - two\n---\n")).toEqual({
      references: ["one", "two"],
    });
  });

  // An inline empty list read as the string made every document that writes
  // supersedes: [] declare a supersede of a document literally named "[]".
  it("reads an inline empty list as an empty array", () => {
    expect(parseFrontmatter("---\nsupersedes: []\n---\n")).toEqual({ supersedes: [] });
  });

  // A blank value is "not decided yet". Reading it as an empty list sent a
  // truthy object downstream, so every deliberately blank field reported as bad.
  it("keeps a blank value as an empty string", () => {
    expect(parseFrontmatter("---\nreviewed:\n---\n")).toEqual({ reviewed: "" });
  });

  it("still makes a list when items follow a blank value", () => {
    expect(parseFrontmatter("---\nreferences:\n  - only\n---\n")).toEqual({ references: ["only"] });
  });

  it("skips comment lines", () => {
    expect(parseFrontmatter("---\n# a note\nkind: sot\n---\n")).toEqual({ kind: "sot" });
  });

  it("allows dots, dashes and underscores in keys", () => {
    expect(parseFrontmatter("---\nsot_ref: x\nadr-id: y\na.b: z\n---\n")).toEqual({
      sot_ref: "x",
      "adr-id": "y",
      "a.b": "z",
    });
  });

  it("reads text that does not open with a fence as no frontmatter", () => {
    expect(parseFrontmatter("# Title\n")).toBeNull();
  });

  it("reads an unclosed fence as no frontmatter", () => {
    expect(parseFrontmatter("---\nkind: plan\n")).toBeNull();
  });

  // The horizontal-rule case: two rules bracket prose that parses to no keys at
  // all. Callers must test the key count, not truthiness -- treating this object
  // as a header once stripped 146 lines of body off a document.
  it("yields an object with no keys for a horizontal rule, not null", () => {
    expect(parseFrontmatter("---\n\n# Title\n\nsome prose\n\n---\n\nmore\n")).toEqual({});
  });

  // A colon in that prose does parse as a key. The guard is the key count at the
  // call site, and this pins why counting keys is not enough on its own.
  it("still reads prose between two rules as a pair when it has a colon", () => {
    expect(parseFrontmatter("---\n\nNote: this reads as a pair\n\n---\n")).toEqual({
      Note: "this reads as a pair",
    });
  });

  it("does not read a dash at column zero as a list item", () => {
    expect(parseFrontmatter("---\nreferences:\n- one\n---\n")).toEqual({ references: "" });
  });

  it("does not read an indented key as a key", () => {
    expect(parseFrontmatter("---\ntop: 1\n  nested: 2\n---\n")).toEqual({ top: "1" });
  });
});

describe("proseOnly", () => {
  it("removes a fenced block", () => {
    expect(proseOnly("before\n```\n[[not-a-link]]\n```\nafter [[real-link]]")).toBe(
      "before\n\nafter [[real-link]]",
    );
  });

  // A document about configuration quotes configuration, and a TOML
  // array-of-tables header is spelled exactly like a wikilink.
  it("removes an inline code span", () => {
    expect(proseOnly("see `[[services]]` and [[real]]")).toBe("see  and [[real]]");
  });

  it("leaves prose without code untouched", () => {
    expect(proseOnly("plain [[link]] text")).toBe("plain [[link]] text");
  });
});

describe("idOf", () => {
  it("strips a sot suffix", () => expect(idOf("workspace-layout.sot.md")).toBe("workspace-layout"));
  it("strips a page suffix", () => expect(idOf("login.page.md")).toBe("login"));
  it("takes only the extension off a plain document", () =>
    expect(idOf("20260831000000-a.md")).toBe("20260831000000-a"));
  it("keeps a decision's full stem", () =>
    expect(idOf("0001-use-postgres.md")).toBe("0001-use-postgres"));
});

describe("kindOf", () => {
  const config = withDefaults();
  it("reads a four-digit prefix as a decision", () =>
    expect(kindOf("0001-use-postgres.md", config)).toBe("decision"));
  it("reads a fourteen-digit prefix as a plan", () =>
    expect(kindOf("20260831140708-a-design.md", config)).toBe("plan"));
  it("reads a sot suffix as a sot", () =>
    expect(kindOf("workspace-layout.sot.md", config)).toBe("sot"));
  it("reads a page suffix as a page", () => expect(kindOf("login.page.md", config)).toBe("page"));
  it("gives a filename matching nothing no kind", () =>
    expect(kindOf("README.md", config)).toBeNull());
  it("gives an uppercase stem no kind", () => expect(kindOf("Some-File.md", config)).toBeNull());
  it("gives a timestamp with no slug no kind", () =>
    expect(kindOf("20260831140708.md", config)).toBeNull());
});

describe("loadConfig", () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "doc-lifecycle-config-"));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const writeConfig = (value: unknown): void =>
    writeFileSync(join(scratch, "spec-conformance.json"), JSON.stringify(value));

  it("gives a repository with no config file the defaults", () => {
    const empty = mkdtempSync(join(tmpdir(), "doc-lifecycle-empty-"));
    try {
      expect(loadConfig(empty).source).toBe("defaults");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("merges a partial config without blanking the rest of a kind", () => {
    writeConfig({ root: ".", kinds: { plan: { dir: "plans", sourceDirs: ["plan"] } } });
    const merged = loadConfig(scratch);
    expect(merged.source).toBe("spec-conformance.json");
    expect(merged.root).toBe(".");
    expect(merged.kinds.plan.sourceDirs).toEqual(["plan"]);
    // Overriding only the destination once left the pattern undefined, and an
    // undefined pattern matched every filename.
    expect(merged.kinds.plan.file).toBe(DEFAULTS.kinds.plan.file);
    expect(merged.kinds.sot.dir).toBe(DEFAULTS.kinds.sot.dir);
    expect(merged.cluster.minDocuments).toBe(DEFAULTS.cluster.minDocuments);
  });

  it("adds a kind the defaults do not know and keeps the known ones", () => {
    writeConfig({ kinds: { runbook: { dir: "runbooks", file: "^(.*)\\.run\\.md$" } } });
    const extended = loadConfig(scratch);
    expect(extended.kinds.runbook.dir).toBe("runbooks");
    expect(Object.keys(extended.kinds)).toHaveLength(5);
  });

  it("refuses invalid JSON by name", () => {
    writeFileSync(join(scratch, "spec-conformance.json"), "{ not json");
    expect(() => loadConfig(scratch)).toThrow(/^spec-conformance\.json is not valid/);
  });

  // An override lets a repository check a candidate tree while its own documents
  // still sit under the old settings, which is the whole of a migration's middle.
  it("reads an override path instead and names it as the source", () => {
    mkdirSync(join(scratch, "nested"), { recursive: true });
    writeFileSync(join(scratch, "nested", "other.json"), JSON.stringify({ root: "docs" }));
    expect(loadConfig(scratch, "nested/other.json").root).toBe("docs");
    expect(loadConfig(scratch, "nested/other.json").source).toBe("nested/other.json");
  });
});
