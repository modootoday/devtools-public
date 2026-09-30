// Reads the document set: which spec roots exist, what kind each document is,
// and what its frontmatter says. Parsing only -- every judgement is in check.ts.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { configForRoot } from "./config.js";
import type { Document, Frontmatter, ScanResult, SpecConfig, SpecRoot } from "./types.js";

const unquote = (value: string): string => value.replace(/^["'](.*)["']$/, "$1").trim();

// Deliberately small: enough for the scalar and list forms a document header
// uses. A full YAML parser would accept shapes the schema then has to reject.
export function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;

  const body = text.slice(4, end);
  const out: Frontmatter = {};
  let key: string | null = null;

  for (const raw of body.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key !== null) {
      if (!Array.isArray(out[key])) out[key] = [];
      (out[key] as string[]).push(unquote(item[1] ?? ""));
      continue;
    }

    const pair = raw.match(/^([A-Za-z_][\w.-]*):\s*(.*)$/);
    if (!pair?.[1]) continue;
    key = pair[1];
    const value = (pair[2] ?? "").trim();
    // An empty value is an empty value. Reading it as an empty list made "not
    // decided yet" arrive downstream as a truthy object, so every deliberately
    // blank field reported as a bad one. A list becomes a list when an item
    // follows it. An inline empty list is a list: reading it as the string "[]"
    // made every document writing supersedes: [] declare a supersede of a
    // document literally named "[]".
    if (value === "[]") out[key] = [];
    else out[key] = value === "" ? "" : unquote(value);
  }
  return out;
}

// Every directory named like the configured root is a spec root. The one at the
// repository root is simply one of them and gets no special treatment.
export function findSpecRoots(repoRoot: string, config: SpecConfig): SpecRoot[] {
  const ignore = new Set(config.ignore);
  const roots: SpecRoot[] = [];

  // A repository that keeps its documents at the top level is a valid
  // configuration, and it is the shape a pile arrives in before it is split.
  if (config.root === "." || config.root === "") {
    return [{ path: repoRoot, package: "." }];
  }
  if (existsSync(join(repoRoot, config.root))) {
    roots.push({ path: join(repoRoot, config.root), package: "." });
  }

  // The configured root at the top level is added above; the walk reaches it
  // again on its first step, and a root counted twice makes every document in
  // it collide with itself.
  const seen = new Set(roots.map((r) => r.path));

  // No depth limit: a fixed one silently skipped packages below it (three at
  // depth 7 in the first repository measured). Symlinked directories are not
  // followed, since a Dirent for a link is not a directory, so the walk ends.
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignore.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.name === config.root) {
        if (!seen.has(path)) {
          seen.add(path);
          roots.push({ path, package: relative(repoRoot, dir) || "." });
        }
        continue;
      }
      if (entry.name.startsWith(".") && entry.name !== config.root) continue;
      walk(path);
    }
  }

  walk(repoRoot);
  return roots;
}

function walkFiles(dir: string, ignore: ReadonlySet<string>, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // Only the ignore list decides. A leading underscore is a sort-order habit,
    // not a marker for "not a document": hiding those files silently dropped the
    // four most-linked sources of truth in the reference repository.
    if (ignore.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, ignore, out);
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

// A kind is decided by the filename alone, so a reader and a tool agree without
// opening the file. Frontmatter stays authoritative and a disagreement is a
// finding, not a tie-break.
export function kindOf(filename: string, config: SpecConfig): string | null {
  for (const [name, spec] of Object.entries(config.kinds)) {
    if (new RegExp(spec.file).test(filename)) return name;
  }
  return null;
}

// Prose only. A document about configuration quotes configuration, and TOML's
// array-of-tables header is spelled exactly like a wikilink; reading code spans
// as links invents references to files nobody ever wrote.
export function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export const idOf = (filename: string): string =>
  filename.replace(/\.(sot|page)\.md$/, "").replace(/\.md$/, "");

export function scan(repoRoot: string, repoConfig: SpecConfig): ScanResult {
  const reserved = new Set(repoConfig.reserved);
  const documents: Document[] = [];
  const roots = findSpecRoots(repoRoot, repoConfig);

  for (const root of roots) {
    const config = configForRoot(repoConfig, relative(repoRoot, root.path));
    const ignore = new Set(config.ignore);
    for (const [kind, spec] of Object.entries(config.kinds)) {
      for (const dirName of [spec.dir, ...(spec.sourceDirs ?? [])]) {
        const kindRoot = join(root.path, dirName);
        if (!existsSync(kindRoot)) continue;

        for (const path of walkFiles(kindRoot, ignore)) {
          const filename = basename(path);
          if (reserved.has(filename)) continue;

          const segments = relative(kindRoot, path).split(sep);

          // A directory whose own name matches the kind pattern is one document
          // made of chapters. The chapters are parts, not documents, so they do
          // not get ids and cannot collide with a chapter of another document.
          let isChapter = false;
          if (spec.allowDirectoryForm && segments.length > 1) {
            const container = basename(dirname(path));
            if (new RegExp(spec.file).test(`${container}.md`)) isChapter = true;
          }

          let text = "";
          try {
            text = readFileSync(path, "utf8");
          } catch {
            continue;
          }

          documents.push({
            path,
            rel: relative(repoRoot, path),
            filename,
            specRoot: root.path,
            package: root.package,
            declaredKind: kind,
            detectedKind: kindOf(filename, config),
            id: idOf(filename),
            isChapter,
            chapterOf: isChapter ? idOf(`${basename(dirname(path))}.md`) : null,
            directoryDomain: !isChapter && segments.length > 1 ? (segments[0] ?? null) : null,
            frontmatter: parseFrontmatter(text),
            text,
            lines: text.split("\n").length,
            mtime: statSync(path).mtimeMs,
          });
        }
      }
    }
  }
  return { roots, documents };
}
