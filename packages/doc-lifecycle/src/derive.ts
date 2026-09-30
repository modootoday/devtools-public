// Gathers the evidence a migration decision needs, and stops there.
//
// It does not decide anything. Status, relationships and placement are
// judgements that require reading the document, and a tool that fills them in
// from filenames produces a normalised pile that is confidently wrong.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { specDir } from "./config.js";
import { sha256 } from "./exposure.js";
import { parseFrontmatter, proseOnly, scan } from "./scan.js";
import type {
  CommitCandidate,
  DeriveSummary,
  Document,
  Dossier,
  Frontmatter,
  KindSpec,
  PathCandidate,
  SpecConfig,
} from "./types.js";

type Touch = { at: number; subject: string };

type HistoryIndex = {
  created: Map<string, number>;
  updated: Map<string, number>;
  touches: Map<string, Touch[]>;
  renamedFrom: Map<string, string>;
};

const day = (ms: number | undefined | null): string | null =>
  ms ? new Date(ms).toISOString().slice(0, 10).replace(/-/g, "") : null;

const list = (v: unknown): string[] =>
  v ? (Array.isArray(v) ? v : [v]).map(String).filter(Boolean) : [];

// A reference often points into a document rather than at it: a section number,
// an anchor, a parenthetical. The document is what is being referenced.
const stripLocator = (text: unknown): string =>
  String(text)
    .trim()
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/\s*[§#].*$/, "")
    .replace(/[.,;)]+$/, "")
    .trim();

// A reference into a directory-form document names one of its chapters, and a
// chapter is a part rather than a document. The thing referenced is the
// document the directory is.
const idFrom = (ref: unknown): string => {
  const text = stripLocator(ref);
  const container = basename(dirname(text));
  if (/^\d{8,14}-/.test(container)) return container.replace(/\.md$/, "");
  return basename(text)
    .replace(/\.(sot|page)\.md$/, "")
    .replace(/\.md$/, "");
};

// One pass over history for every file. A per-file git log would take an hour
// at this scale and prove the same thing.
export function historyIndex(repoRoot: string): HistoryIndex {
  const created = new Map<string, number>();
  const updated = new Map<string, number>();
  const touches = new Map<string, Touch[]>();
  const renamedFrom = new Map<string, string>();

  let out = "";
  try {
    out = execFileSync(
      "git",
      ["log", "--format=C|%ct|%s", "--name-status", "--reverse", "--find-renames"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
    );
  } catch {
    return { created, updated, touches, renamedFrom };
  }

  let when: number | null = null;
  let subject = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("C|")) {
      const [, ts, ...rest] = line.split("|");
      when = Number(ts) * 1000;
      subject = rest.join("|");
      continue;
    }
    if (!line.trim() || !when) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "")[0];
    const from = parts[1];
    const path = status === "R" ? parts[2] : from;
    if (!path) continue;

    if (status === "R" && from) {
      renamedFrom.set(path, from);
      if (!created.has(path)) created.set(path, created.get(from) ?? when);
    } else if (!created.has(path)) {
      created.set(path, when);
    }
    updated.set(path, when);
    if (!touches.has(path)) touches.set(path, []);
    // The commit subjects are the cheapest honest account of what happened to a
    // document; a reader deciding its status wants them, not a guess from them.
    touches.get(path)!.push({ at: when, subject });
  }
  return { created, updated, touches, renamedFrom };
}

// Commits whose subject cites the document, by id or by its slug. A plan that
// was carried out usually leaves its name in the history.
export function citationIndex(repoRoot: string): Map<string, Touch[]> {
  const byToken = new Map<string, Touch[]>();
  let out = "";
  try {
    out = execFileSync("git", ["log", "--format=%ct|%s"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return byToken;
  }
  for (const line of out.split("\n")) {
    const i = line.indexOf("|");
    if (i === -1) continue;
    const at = Number(line.slice(0, i)) * 1000;
    const subject = line.slice(i + 1);
    for (const token of subject.toLowerCase().match(/[a-z0-9][a-z0-9-]{6,}/g) ?? []) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token)!.push({ at, subject });
    }
  }
  return byToken;
}

// Commits indexed by every prefix of every path they touch, so a document can
// ask what happened to the areas it names inside a given window.
function commitsByPrefixIndex(repoRoot: string): Map<string, Touch[]> {
  const byPrefix = new Map<string, Touch[]>();
  let out = "";
  try {
    out = execFileSync("git", ["log", "--format=C|%ct|%s", "--name-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    // history unavailable; the window block reports nothing rather than guessing
    return byPrefix;
  }
  let at: number | null = null;
  let subject = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("C|")) {
      const [, ts, ...rest] = line.split("|");
      at = Number(ts) * 1000;
      subject = rest.join("|");
      continue;
    }
    if (!line.trim() || !at) continue;
    const entry = { at, subject };
    let node = line;
    for (;;) {
      if (!byPrefix.has(node)) byPrefix.set(node, []);
      byPrefix.get(node)!.push(entry);
      const cut = node.lastIndexOf("/");
      if (cut === -1) break;
      node = node.slice(0, cut);
    }
  }
  return byPrefix;
}

// One pass for path -> last touch, so "was this area worked on after the
// document was written" costs nothing per document.
function lastTouchIndex(repoRoot: string): Map<string, number> {
  const pathTouched = new Map<string, number>();
  let out = "";
  try {
    out = execFileSync("git", ["log", "--format=C|%ct", "--name-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    // history unavailable; the implementation block simply reports less
    return pathTouched;
  }
  let when: number | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("C|")) {
      when = Number(line.slice(2)) * 1000;
      continue;
    }
    if (!line.trim() || !when) continue;
    if (!pathTouched.has(line)) pathTouched.set(line, when);
  }
  return pathTouched;
}

// Paths a document names are the cheapest link between what was written and
// what exists. Whether their presence means the work was done is a judgement;
// their presence is a fact.
const PATH_RE = /`([a-z0-9._@/-]*\/[a-z0-9._@/-]+)`/gi;

// Candidates, not conclusions. Whether a path-shaped token names a real
// location, a placeholder in an instruction, or an example is a reading
// judgement, and every heuristic added here is that judgement smuggled into a
// regular expression -- where the next exception cannot see it.
export function pathCandidates(text: string): { token: string; line: number; context: string }[] {
  const found = new Map<string, { token: string; line: number; context: string }>();
  text.split("\n").forEach((line, index) => {
    for (const m of line.matchAll(PATH_RE)) {
      const token = (m[1] ?? "").replace(/^\.\//, "").replace(/\*+$/, "").replace(/\/$/, "");
      if (token.length < 4 || token.includes("://")) continue;
      if (found.has(token)) continue;
      found.set(token, { token, line: index + 1, context: line.trim().slice(0, 160) });
    }
  });
  return [...found.values()].slice(0, 40);
}

export type DeriveOptions = {
  /** A classification the reading pass produced, as JSONL rows. */
  classifications?: ClassificationRow[];
  /** Destination root for proposedPath. Defaults to specDir(config). */
  into?: string;
};

export type ClassificationRow = {
  path: string;
  kind?: string;
  id?: string;
  package?: string;
  domain?: string | null;
  chapterOf?: string | null;
};

type DerivableDocument = Pick<
  Document,
  | "rel"
  | "package"
  | "declaredKind"
  | "id"
  | "filename"
  | "frontmatter"
  | "directoryDomain"
  | "text"
  | "lines"
  | "isChapter"
  | "chapterOf"
>;

// Two ways in, and the second is the general case. A repository that has
// already adopted the layout can be scanned; a repository that has not is read
// from a classification the reading pass produced, because in that repository
// there is no directory or filename shape entitled to say what a document is.
export function documentsFromClassification(
  repoRoot: string,
  config: SpecConfig,
  rows: readonly ClassificationRow[],
): DerivableDocument[] {
  const docs: DerivableDocument[] = [];
  for (const row of rows) {
    if (!row.kind || row.kind === "none") continue;
    const abs = join(repoRoot, row.path);
    if (!existsSync(abs)) continue;
    if (!config.kinds[row.kind]) continue;
    const text = readFileSync(abs, "utf8");
    docs.push({
      rel: row.path,
      package: row.package ?? ".",
      declaredKind: row.kind,
      id:
        row.id ??
        basename(row.path)
          .replace(/\.(sot|page)\.md$/, "")
          .replace(/\.md$/, ""),
      filename: basename(row.path),
      frontmatter: parseFrontmatter(text) ?? {},
      directoryDomain: row.domain ?? null,
      text,
      lines: text.split("\n").length,
      isChapter: Boolean(row.chapterOf),
      chapterOf: row.chapterOf ?? null,
    });
  }
  return docs;
}

// A document whose header declares an id other than its filename stem is
// linked to by that id, so the destination is named after it. Renaming keeps
// every existing link resolving without rewriting the prose that holds it.
export function destinationFilename(
  doc: Pick<Document, "id" | "filename">,
  spec: KindSpec,
  fm: Frontmatter,
): string {
  const declared = fm[spec.idField ?? "id"];
  if (typeof declared !== "string" || declared === doc.id) return doc.filename;
  const suffix = doc.filename.startsWith(doc.id) ? doc.filename.slice(doc.id.length) : "";
  // A source named outside the kind's convention (SOT_FORMAT.md holding a sot)
  // takes the kind's own suffix, or it would stay invisible to the checker.
  const pattern = new RegExp(spec.file);
  const candidates = [suffix, ".sot.md", ".page.md", ".md"].filter(Boolean).map((s) => `${declared}${s}`);
  return candidates.find((name) => pattern.test(name)) ?? doc.filename;
}

export function deriveDossiers(
  repoRoot: string,
  config: SpecConfig,
  options: DeriveOptions = {},
): { dossiers: Dossier[]; summary: DeriveSummary } {
  const documents: DerivableDocument[] = options.classifications
    ? documentsFromClassification(repoRoot, config, options.classifications)
    : scan(repoRoot, config).documents;
  const docs = documents.filter((d) => !d.isChapter);

  const history = historyIndex(repoRoot);
  const citations = citationIndex(repoRoot);
  const commitsByPrefix = commitsByPrefixIndex(repoRoot);
  const pathTouched = lastTouchIndex(repoRoot);
  const into = options.into ?? specDir(config);

  const dossiers: Dossier[] = [];
  const summary: DeriveSummary = {
    withCreated: 0,
    statusUsable: 0,
    statusFreeText: 0,
    withDeclared: 0,
    needsReading: 0,
  };

  for (const doc of docs) {
    // A classification row can name a kind the configuration dropped between
    // the reading pass and this one. Skipping is the honest answer: there is no
    // vocabulary to derive a status or a destination against.
    const spec = config.kinds[doc.declaredKind];
    if (!spec) continue;
    const fm: Frontmatter = doc.frontmatter ?? {};
    const created = day(history.created.get(doc.rel));
    const updated = day(history.updated.get(doc.rel));
    const commits = history.touches.get(doc.rel) ?? [];

    const statusUsable =
      typeof fm.status === "string" && spec.status.includes(fm.status) ? fm.status : null;
    const declared = {
      supersedes: list(fm.supersedes).map(idFrom),
      references: [
        ...new Set([
          ...[config.referenceField, ...(config.referenceAliases ?? [])]
            .flatMap((f) => list(fm[f]))
            .map(idFrom),
          ...[...proseOnly(doc.text).matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map((m) => m[1] ?? ""),
        ]),
      ],
    };

    // Named honestly so the reading pass knows what it is being asked for,
    // rather than discovering an empty field and inventing a value to fill it.
    const unknown: { field: string; why: string }[] = [];
    if (!statusUsable) {
      unknown.push({ field: "status", why: fm.status ? `free text: ${String(fm.status)}` : "absent" });
    }
    if (declared.supersedes.length === 0) {
      unknown.push({ field: "supersedes", why: "no relationship declared anywhere" });
    }
    unknown.push({ field: "reviewed", why: "nobody has confirmed this document" });

    if (created) summary.withCreated += 1;
    if (statusUsable) summary.statusUsable += 1;
    else if (fm.status) summary.statusFreeText += 1;
    if (declared.supersedes.length || declared.references.length) summary.withDeclared += 1;
    if (unknown.length > 0) summary.needsReading += 1;

    // Implementation evidence: facts about the code, never a verdict on whether
    // the document's work happened. That verdict needs the document read.
    const createdAt = history.created.get(doc.rel) ?? 0;
    const candidates: PathCandidate[] = pathCandidates(doc.text).map((c) => {
      const exists = existsSync(join(repoRoot, c.token));
      let touchedAfter = false;
      for (const [f, at] of pathTouched) {
        if ((f === c.token || f.startsWith(`${c.token}/`)) && at > createdAt) {
          touchedAfter = true;
          break;
        }
      }
      // exists and touchedAfter are facts about the tree. Whether this token was
      // ever meant to be a path is left to the reader, with the line it appeared
      // on as the evidence for deciding.
      return { ...c, exists, touchedAfter };
    });

    // Candidates for "what carried this out", narrowest first. The window a
    // document was live in is the tightest honest scope; widening past it is
    // only done when it is empty, and the fact that it was widened travels with
    // the answer. Which candidate is the work -- if any is -- is read, not
    // decided here.
    const openedAt = createdAt;
    const closedAt = history.updated.get(doc.rel) ?? openedAt;
    const inWindow = new Map<string, Touch & { path: string }>();
    const afterWindow = new Map<string, Touch & { path: string }>();
    for (const c of candidates) {
      for (const entry of commitsByPrefix.get(c.token) ?? []) {
        const key = `${entry.at}|${entry.subject}`;
        if (entry.at >= openedAt && entry.at <= closedAt) inWindow.set(key, { ...entry, path: c.token });
        else if (entry.at > closedAt) afterWindow.set(key, { ...entry, path: c.token });
      }
    }
    const shape = (m: Map<string, Touch & { path: string }>): CommitCandidate[] =>
      [...m.values()]
        .sort((a, b) => a.at - b.at)
        .slice(0, 10)
        .map((c) => ({ on: day(c.at), subject: c.subject.slice(0, 110), path: c.path }));

    let scope: "none" | "in-window" | "widened-past-window" = "none";
    let widenedBecause: string | null = null;
    let commitCandidates: CommitCandidate[] = [];
    if (inWindow.size > 0) {
      scope = "in-window";
      commitCandidates = shape(inWindow);
    } else if (afterWindow.size > 0) {
      scope = "widened-past-window";
      widenedBecause =
        "no commit touched the paths this document names while it was still being edited";
      commitCandidates = shape(afterWindow);
    } else if (candidates.length === 0) {
      widenedBecause = "the document names no paths to search on";
    } else {
      widenedBecause = "no commit in history touched the paths this document names";
    }

    const slug = doc.id.replace(/^\d{4,14}[-_]?/, "");
    const cited = (citations.get(slug) ?? [])
      .slice(-5)
      .map((c) => ({ on: day(c.at), subject: c.subject.slice(0, 110) }));
    const boxes = doc.text.match(/^\s*[-*] \[[ xX]\]/gm) ?? [];

    const domain = spec.domain === false ? null : ((fm.domain as string) ?? doc.directoryDomain ?? null);
    const filename = destinationFilename(doc, spec, fm);

    dossiers.push({
      source: doc.rel,
      package: doc.package,
      // Derived: provable from the filename, the directory or git.
      derived: {
        kind: doc.declaredKind,
        id: doc.id,
        domain,
        created,
        updated,
        renamedFrom: history.renamedFrom.get(doc.rel) ?? null,
        lines: doc.lines,
        chapters: documents.filter((d) => d.chapterOf === doc.id).map((d) => d.rel),
      },
      // Declared: someone wrote it down; carrying it across is derivation.
      declared: { status: statusUsable, ...declared },
      // Everything the author wrote in the header, so the apply stage can carry
      // across whatever this schema has no field for.
      originalFrontmatter: fm,
      sourceSha256: sha256(doc.text),
      // Unknown: requires reading the document. Left for a person or a model.
      unknown,
      // Evidence for that reading, not a substitute for it.
      evidence: {
        commits: commits.slice(-8).map((c) => ({ on: day(c.at), subject: c.subject.slice(0, 120) })),
        headings: doc.text
          .split("\n")
          .filter((l) => /^#{1,3}\s/.test(l))
          .slice(0, 12)
          .map((l) => l.replace(/^#+\s*/, "").slice(0, 90)),
      },
      implementation: {
        commitSearch: {
          window: {
            opened: day(openedAt),
            closed: day(closedAt),
            days: openedAt ? Math.round((closedAt - openedAt) / 86_400_000) : null,
          },
          scope,
          widenedBecause,
          counts: { inWindow: inWindow.size, afterWindow: afterWindow.size },
          candidates: commitCandidates,
        },
        pathCandidates: candidates,
        candidatesPresent: candidates.filter((c) => c.exists).length,
        candidatesTouchedAfterWriting: candidates.filter((c) => c.touchedAfter).length,
        commitsCitingSlug: cited,
        tasks: {
          done: boxes.filter((b) => /\[[xX]\]/.test(b)).length,
          open: boxes.filter((b) => /\[ \]/.test(b)).length,
        },
      },
      proposedPath: join(into, spec.dir, domain && spec.domain !== false ? domain : "", filename),
    });
  }

  return { dossiers, summary };
}
