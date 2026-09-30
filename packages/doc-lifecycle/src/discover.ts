// Finds candidate design documents in a repository that has no convention yet.
//
// It classifies nothing. Every document gets signals and no verdict, because
// whether a file is a design document, a readme, a changelog or a note is a
// reading judgement, and a heuristic that decides it here is a convention
// imposed on a repository that has not chosen one.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

import type { Candidate } from "./types.js";

// Only places a document certainly is not. These are build outputs and package
// caches, named the same in every repository, which is why they are a default
// rather than a required parameter.
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".output",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  "target",
  "__snapshots__",
];

export const DEFAULT_DOC_EXTENSIONS: readonly string[] = [
  ".md",
  ".mdx",
  ".markdown",
  ".rst",
  ".adoc",
  ".txt",
];

export type DiscoverOptions = {
  skipDirs?: readonly string[];
  extensions?: readonly string[];
  maxDepth?: number;
};

function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  skip: ReadonlySet<string>,
  extensions: ReadonlySet<string>,
  out: string[],
): string[] {
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      walk(path, depth + 1, maxDepth, skip, extensions, out);
    } else if (extensions.has(extname(entry.name).toLowerCase())) {
      out.push(path);
    }
  }
  return out;
}

function frontmatterKeys(text: string): string[] | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const keys = text
    .slice(4, end)
    .split("\n")
    .map((l) => l.match(/^([A-Za-z_][\w.-]*):/)?.[1])
    .filter((k): k is string => Boolean(k));
  return [...new Set(keys)];
}

function historyDates(root: string): { created: Map<string, number>; updated: Map<string, number> } {
  const created = new Map<string, number>();
  const updated = new Map<string, number>();
  try {
    const out = execFileSync("git", ["log", "--format=C|%ct", "--name-only", "--reverse"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    let when: number | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("C|")) {
        when = Number(line.slice(2)) * 1000;
        continue;
      }
      if (!line.trim() || !when) continue;
      if (!created.has(line)) created.set(line, when);
      updated.set(line, when);
    }
  } catch {
    // not a repository, or history unavailable
  }
  return { created, updated };
}

const day = (ms: number | undefined): string | null =>
  ms ? new Date(ms).toISOString().slice(0, 10).replace(/-/g, "") : null;

export function discoverCandidates(repoRoot: string, options: DiscoverOptions = {}): Candidate[] {
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const extensions = new Set(options.extensions ?? DEFAULT_DOC_EXTENSIONS);
  const files = walk(repoRoot, 0, options.maxDepth ?? 12, skip, extensions, []);
  const { created, updated } = historyDates(repoRoot);

  const candidates: Candidate[] = [];
  for (const path of files) {
    const rel = relative(repoRoot, path);
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const headings = lines
      .filter((l) => /^#{1,3}\s/.test(l))
      .map((l) => l.replace(/^#+\s*/, "").trim().slice(0, 90));
    const filename = rel.split("/").pop()!;

    candidates.push({
      path: rel,
      // Where it sits, without deciding what that means.
      directory: dirname(rel),
      filename,
      // Shape signals a reader can weigh. None of them classifies anything: a
      // leading timestamp is common in proposals and also in meeting notes.
      signals: {
        bytes: statSync(path).size,
        lines: lines.length,
        leadingDigits: (filename.match(/^(\d+)/) ?? [])[1]?.length ?? 0,
        hasFrontmatter: text.startsWith("---"),
        frontmatterKeys: frontmatterKeys(text) ?? [],
        title: headings[0] ?? null,
        headings: headings.slice(0, 12),
        taskBoxes: (text.match(/^\s*[-*] \[[ xX]\]/gm) ?? []).length,
        wikilinks: [
          ...new Set([...text.matchAll(/\[\[([^\]|]+)\]\]/g)].map((m) => m[1] ?? "")),
        ].slice(0, 20),
        created: day(created.get(rel)),
        updated: day(updated.get(rel)),
      },
      // Filled in by the reading pass. Absent means nobody has looked yet, which
      // is different from "not a design document".
      classification: null,
    });
  }
  return candidates;
}
