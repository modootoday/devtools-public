// Draws the document graph, and checks the invariants that only a graph can see.

import { execFileSync } from "node:child_process";

import { proseOnly } from "./scan.js";
import type {
  Commit,
  CommitEdge,
  Document,
  Finding,
  GraphCode,
  GraphEdge,
  GraphResult,
  SpecConfig,
  View,
  ViewEdge,
  ViewNode,
} from "./types.js";

const toList = (value: unknown): string[] => {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
};

export const nodeKey = (doc: Pick<Document, "specRoot" | "id">): string => `${doc.specRoot}::${doc.id}`;

const stemOf = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.(sot|page)\.md$/, "").replace(/\.md$/, "");

export function loadHistory(repoRoot: string): Commit[] {
  const commits: Commit[] = [];
  try {
    const out = execFileSync("git", ["log", "--format=C|%h|%ct|%s", "--name-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    let current: Commit | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("C|")) {
        const [, hash, ts, ...rest] = line.split("|");
        current = { hash: hash ?? "", at: Number(ts) * 1000, subject: rest.join("|"), paths: [] };
        commits.push(current);
        continue;
      }
      if (line.trim() && current) current.paths.push(line);
    }
  } catch {
    // no history available; commit edges are simply absent
  }
  return commits;
}

// History is part of the graph, not a lookup beside it. A document that claims
// work connects to the commits that did it through the paths it names, and
// without those edges the graph can only say what documents say about each
// other.
const PATH_RE = /`([a-z0-9._@/-]*\/[a-z0-9._@/-]+)`/gi;

export function namedPaths(text: string, pathRoots: readonly string[]): string[] {
  const out = new Set<string>();
  const roots = pathRoots.length > 0 ? new RegExp(`^(${pathRoots.map(escapeRe).join("|")})/`) : null;
  for (const m of text.matchAll(PATH_RE)) {
    const p = (m[1] ?? "").replace(/^\.\//, "").replace(/[*/]+$/, "");
    if (/YYYY|NNNN|<[^>]+>|\{/.test(p)) continue;
    if (p.length < 4) continue;
    if (roots && !roots.test(p)) continue;
    out.add(p);
  }
  return [...out].slice(0, 40);
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// fileExists answers for a repository path. A retired file that stays behind as
// a redirect stub is a citation that resolves, just not to a document; without
// it every such citation dangles, which is the conservative reading.
export type BuildGraphOptions = { history?: Commit[]; fileExists?: (repoPath: string) => boolean };

export function buildGraph(
  documents: readonly Document[],
  config: SpecConfig,
  options: BuildGraphOptions = {},
): GraphResult {
  const docs = documents.filter((d) => !d.isChapter);
  const history = options.history ?? [];

  const nodes = new Map<string, Document>();
  for (const doc of docs) nodes.set(nodeKey(doc), doc);

  // A migration renames documents, and links written before it still point at
  // the old name. Every document records where it came from, so the name it
  // used to have resolves too -- otherwise adopting the layout breaks the links
  // adopting it was supposed to fix.
  const formerNames = new Map<string, Document[]>();
  for (const d of docs) {
    const source = d.frontmatter?.source;
    if (!source) continue;
    const former = stemOf(String(source));
    if (former === d.id) continue;
    if (!formerNames.has(former)) formerNames.set(former, []);
    formerNames.get(former)!.push(d);
  }

  type Resolution = { doc: Document; scope: string } | { ambiguous: Document[] } | null;

  // A link resolves in its own spec root first and the repository second. That
  // is how a wikilink behaves, and it is what lets two packages both hold a
  // document called overview without either needing a prefix.
  function resolveLink(from: Document, id: string): Resolution {
    const local = nodes.get(`${from.specRoot}::${id}`);
    if (local) return { doc: local, scope: "local" };
    const global = docs.filter((d) => d.id === id);
    if (global.length === 1) return { doc: global[0]!, scope: "repo" };
    if (global.length > 1) return { ambiguous: global };
    const former = formerNames.get(id) ?? [];
    if (former.length === 1) return { doc: former[0]!, scope: "former-name" };
    if (former.length > 1) return { ambiguous: former };
    // Documents are talked about by their subject, not by the timestamp in
    // front of it. A reference to community-mission means the document whose id
    // ends that way, and refusing to see that reports a broken link that is not.
    const bySlug = docs.filter((d) => d.id.replace(/^\d{4,14}-/, "") === id);
    if (bySlug.length === 1) return { doc: bySlug[0]!, scope: "slug" };
    if (bySlug.length > 1) return { ambiguous: bySlug };
    return null;
  }

  // Relations are written as paths with annotations as often as bare ids, and a
  // plan is cited by its timestamp alone. Supersedes and references read the
  // same way, so a relation's field name does not decide whether it resolves.
  const locate = (target: unknown): string =>
    String(target)
      .trim()
      .replace(/\s*\(.*\)\s*$/, "")
      .replace(/\s*[§#].*$/, "")
      .replace(/[.,;)]+$/, "")
      .trim();

  const standsAsFile = (target: unknown): boolean => {
    const located = locate(target);
    return located.includes("/") && (options.fileExists?.(located) ?? false);
  };

  function resolveTarget(from: Document, target: unknown): Resolution {
    const located = locate(target);
    const id = located
      .replace(/^.*\//, "")
      .replace(/\.(sot|page)\.md$/, "")
      .replace(/\.md$/, "");
    let found = resolveLink(from, id);
    if (!found && /^\d{14}$/.test(id)) {
      const stamped = docs.filter((d) => d.id.startsWith(`${id}-`));
      if (stamped.length === 1) found = { doc: stamped[0]!, scope: "timestamp" };
    }
    // A reference can name a chapter of a directory-form document. Chapters
    // are parts, not documents, so they have no id of their own and would
    // dangle forever; the thing referenced is the document they belong to.
    if (!found || "ambiguous" in found) {
      const container = located.includes("/")
        ? located.replace(/\/[^/]*$/, "").replace(/^.*\//, "")
        : null;
      if (container) found = resolveLink(from, container);
    }
    return found;
  }

  const edges: GraphEdge[] = [];
  const findings: Finding<GraphCode>[] = [];

  for (const doc of docs) {
    const fm = doc.frontmatter ?? {};

    for (const match of proseOnly(doc.text).matchAll(/\[\[([a-z0-9-]+)\]\]/g)) {
      const target = match[1] ?? "";
      const found = resolveLink(doc, target);
      if (!found) {
        findings.push({ code: "LINK_DANGLING", path: doc.rel, detail: `[[${target}]] resolves to nothing` });
      } else if ("ambiguous" in found) {
        findings.push({
          code: "LINK_AMBIGUOUS",
          path: doc.rel,
          detail: `[[${target}]] matches ${found.ambiguous.length} documents outside this spec root`,
        });
      } else edges.push({ from: doc, to: found.doc, type: "link" });
    }

    for (const target of toList(fm.supersedes)) {
      const found = resolveTarget(doc, target);
      if (!found || "ambiguous" in found) {
        if (standsAsFile(target)) continue;
        findings.push({
          code: "SUPERSEDE_DANGLING",
          path: doc.rel,
          detail: `supersedes "${target}" resolves to nothing`,
        });
        continue;
      }
      edges.push({ from: doc, to: found.doc, type: "supersedes" });
      // The pair must agree, or a reader arriving at the older document is
      // never told there is a newer one.
      const back = toList(found.doc.frontmatter?.supersededBy);
      if (back.length > 0 && !back.includes(doc.id)) {
        findings.push({
          code: "SUPERSEDE_ONE_SIDED",
          path: found.doc.rel,
          detail: `superseded by ${doc.id}, but names ${back.join(", ")}`,
        });
      }
    }

    if (fm.status === "superseded" && toList(fm.supersededBy).length === 0) {
      findings.push({
        code: "SUCCESSOR_MISSING",
        path: doc.rel,
        detail: "status is superseded but no successor is named",
      });
    }

    const referenceFields = [config.referenceField, ...(config.referenceAliases ?? [])];
    const referenced = referenceFields.flatMap((f) => toList(fm[f]));
    // Documents cite code as often as they cite each other. A reference ending
    // in a source extension is a pointer into the tree, not a document link.
    const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|sh|py|sql|json|ya?ml|toml|css|html)$/i;
    for (const ref of referenced) {
      if (!ref || ref === "null" || CODE.test(String(ref).trim())) continue;
      const found = resolveTarget(doc, ref);
      if ((!found || "ambiguous" in found) && standsAsFile(ref)) continue;
      if (!found || "ambiguous" in found) {
        findings.push({ code: "REF_DANGLING", path: doc.rel, detail: `reference "${ref}" resolves to nothing` });
      } else edges.push({ from: doc, to: found.doc, type: "ref" });
    }
  }

  // Document -> path -> commit. The middle hop is what makes a claim checkable:
  // the document names an area, and history says who touched it since.
  const commitEdges: CommitEdge[] = [];
  if (history.length > 0) {
    // Index every touched file and each of its ancestor directories, so a
    // document's named path is one lookup rather than a scan of the whole
    // history. Without this the join is documents x paths x files and does not
    // finish.
    const byPrefix = new Map<string, Commit[]>();
    for (const commit of history) {
      for (const path of commit.paths) {
        let at = path;
        for (;;) {
          if (!byPrefix.has(at)) byPrefix.set(at, []);
          byPrefix.get(at)!.push(commit);
          const cut = at.lastIndexOf("/");
          if (cut === -1) break;
          at = at.slice(0, cut);
        }
      }
    }

    const bySubjectToken = new Map<string, Commit[]>();
    for (const commit of history) {
      for (const token of commit.subject.toLowerCase().match(/[a-z0-9][a-z0-9-]{7,}/g) ?? []) {
        if (!bySubjectToken.has(token)) bySubjectToken.set(token, []);
        bySubjectToken.get(token)!.push(commit);
      }
    }

    const createdAt = new Map<string, number>();
    for (const commit of [...history].reverse()) {
      for (const path of commit.paths) if (!createdAt.has(path)) createdAt.set(path, commit.at);
    }

    for (const doc of docs) {
      // A normalised copy is born the day it is written, so its own history says
      // every commit predates it and the whole join collapses. The document's
      // birth is where it came from: the source path it records, then the
      // created field, and only then the file itself.
      const fm = doc.frontmatter ?? {};
      const fromSource = fm.source ? createdAt.get(String(fm.source)) : undefined;
      const created = String(fm.created ?? "");
      const fromField = fm.created
        ? Date.parse(`${created.slice(0, 4)}-${created.slice(4, 6)}-${created.slice(6, 8)}`)
        : Number.NaN;
      const born = fromSource ?? (Number.isNaN(fromField) ? (createdAt.get(doc.rel) ?? 0) : fromField);
      const seen = new Set<string>();
      for (const path of namedPaths(doc.text, config.pathRoots)) {
        for (const commit of byPrefix.get(path) ?? []) {
          if (commit.at < born) continue;
          const k = `${commit.hash}|${path}`;
          if (seen.has(k)) continue;
          seen.add(k);
          commitEdges.push({ doc, path, commit });
        }
      }
      const slug = doc.id.replace(/^\d{4,14}[-_]?/, "");
      for (const commit of bySubjectToken.get(slug) ?? []) {
        commitEdges.push({ doc, path: null, commit, cited: true });
      }
    }
  }

  // A supersede chain that loops has no newest member, so nothing is current.
  const chain = new Map<string, string>();
  for (const edge of edges.filter((e) => e.type === "supersedes")) {
    chain.set(nodeKey(edge.from), nodeKey(edge.to));
  }
  for (const start of chain.keys()) {
    const seen = new Set([start]);
    let at = chain.get(start);
    while (at) {
      if (seen.has(at)) {
        findings.push({
          code: "SUPERSEDE_CYCLE",
          path: nodes.get(start)?.rel ?? start,
          detail: "supersede chain loops",
        });
        break;
      }
      seen.add(at);
      at = chain.get(at);
    }
  }

  return { documents: docs, nodes, edges, commitEdges, findings };
}

export type ViewName = "domains" | "supersedes" | "orphans" | "neighborhood" | "kind" | "timeline";

export const VIEW_NAMES: readonly ViewName[] = [
  "domains",
  "supersedes",
  "orphans",
  "neighborhood",
  "kind",
  "timeline",
];

export type ViewOptions = { id?: string | null; depth?: number; kind?: string };

const label = (doc: Pick<Document, "id">): string => doc.id.slice(0, 40);

// Views are scoped by default. A picture of a thousand nodes is not a picture,
// and drawing one costs the time it took to draw.
export function graphView(
  graph: GraphResult,
  config: SpecConfig,
  view: ViewName,
  options: ViewOptions = {},
): View {
  const { documents: docs, nodes, edges, commitEdges } = graph;
  const viewNodes: ViewNode[] = [];
  const viewEdges: ViewEdge[] = [];

  if (view === "domains") {
    // Only a kind that declares a domain has one; for the rest the kind is the
    // coarsest honest grouping.
    const domainOf = (doc: Document): string =>
      config.kinds[doc.declaredKind]?.domain === false
        ? doc.declaredKind
        : String(doc.frontmatter?.domain ?? doc.directoryDomain ?? doc.declaredKind);
    const counted = new Map<string, number>();
    for (const doc of docs) counted.set(domainOf(doc), (counted.get(domainOf(doc)) ?? 0) + 1);
    for (const [name, n] of counted) viewNodes.push({ id: name, text: `${name} (${n})` });
    const pairs = new Map<string, number>();
    for (const edge of edges) {
      const a = domainOf(edge.from);
      const b = domainOf(edge.to);
      if (a === b) continue;
      pairs.set(`${a}|${b}`, (pairs.get(`${a}|${b}`) ?? 0) + 1);
    }
    for (const [k, n] of pairs) {
      const [a, b] = k.split("|");
      viewEdges.push({ from: a ?? "", to: b ?? "", text: String(n) });
    }
    return { title: view, nodes: viewNodes, edges: viewEdges };
  }

  if (view === "supersedes") {
    const used = new Set<string>();
    for (const edge of edges.filter((e) => e.type === "supersedes")) {
      used.add(nodeKey(edge.from));
      used.add(nodeKey(edge.to));
      viewEdges.push({ from: nodeKey(edge.from), to: nodeKey(edge.to), text: "supersedes" });
    }
    for (const k of used) viewNodes.push({ id: k, text: label(nodes.get(k) ?? { id: k }) });
    return { title: view, nodes: viewNodes, edges: viewEdges };
  }

  if (view === "orphans") {
    const referenced = new Set(edges.map((e) => nodeKey(e.to)));
    const referencing = new Set(edges.map((e) => nodeKey(e.from)));
    for (const d of docs) {
      if (referenced.has(nodeKey(d)) || referencing.has(nodeKey(d))) continue;
      viewNodes.push({ id: nodeKey(d), text: label(d) });
    }
    return { title: view, nodes: viewNodes, edges: viewEdges };
  }

  if (view === "neighborhood") {
    const focus = options.id;
    if (!focus) throw new Error("the neighborhood view needs a document id");
    const start = docs.find((d) => d.id === focus);
    if (!start) throw new Error(`no document with id "${focus}"`);
    const depth = options.depth ?? 2;
    const keep = new Set([nodeKey(start)]);
    for (let i = 0; i < depth; i += 1) {
      for (const edge of edges) {
        if (keep.has(nodeKey(edge.from))) keep.add(nodeKey(edge.to));
        else if (keep.has(nodeKey(edge.to))) keep.add(nodeKey(edge.from));
      }
    }
    for (const k of keep) viewNodes.push({ id: k, text: label(nodes.get(k) ?? { id: k }) });
    for (const e of edges) {
      if (!keep.has(nodeKey(e.from)) || !keep.has(nodeKey(e.to))) continue;
      viewEdges.push({ from: nodeKey(e.from), to: nodeKey(e.to), text: e.type });
    }
    return { title: `neighborhood of ${focus}`, nodes: viewNodes, edges: viewEdges };
  }

  if (view === "timeline") {
    const focus = options.id;
    if (!focus) throw new Error("the timeline view needs a document id");
    if (!docs.some((d) => d.id === focus)) throw new Error(`no document with id "${focus}"`);
    const seen = new Map<string, { commit: Commit; paths: Set<string>; cited: boolean }>();
    for (const e of commitEdges.filter((edge) => edge.doc.id === focus)) {
      if (!seen.has(e.commit.hash)) {
        seen.set(e.commit.hash, { commit: e.commit, paths: new Set(), cited: false });
      }
      if (e.path) seen.get(e.commit.hash)!.paths.add(e.path);
      if (e.cited) seen.get(e.commit.hash)!.cited = true;
    }
    const ordered = [...seen.values()].sort((a, b) => a.commit.at - b.commit.at);
    viewNodes.push({ id: `doc:${focus}`, text: `${focus} (document)` });
    let previous = `doc:${focus}`;
    for (const item of ordered.slice(-30)) {
      const id = `c:${item.commit.hash}`;
      const when = new Date(item.commit.at).toISOString().slice(0, 10);
      viewNodes.push({ id, text: `${when} ${item.commit.subject.slice(0, 48)}` });
      const text = item.cited ? "cites" : `touches ${[...item.paths][0] ?? ""}`.slice(0, 30);
      viewEdges.push({ from: previous, to: id, text });
      previous = id;
    }
    return {
      title: `timeline of ${focus}: ${ordered.length} commits after it was written`,
      nodes: viewNodes,
      edges: viewEdges,
    };
  }

  const which = options.kind ?? "sot";
  const keep = new Set(docs.filter((d) => d.declaredKind === which).map(nodeKey));
  for (const k of keep) viewNodes.push({ id: k, text: label(nodes.get(k)!) });
  for (const e of edges) {
    if (!keep.has(nodeKey(e.from)) || !keep.has(nodeKey(e.to))) continue;
    viewEdges.push({ from: nodeKey(e.from), to: nodeKey(e.to), text: e.type });
  }
  return { title: `kind ${which}`, nodes: viewNodes, edges: viewEdges };
}

const safe = (id: string): string => `n${Buffer.from(id).toString("hex").slice(0, 24)}`;

export function renderMermaid(view: View): string {
  const lines = [`%% ${view.title}: ${view.nodes.length} nodes, ${view.edges.length} edges`, "graph TD"];
  for (const n of view.nodes) lines.push(`  ${safe(n.id)}["${n.text}"]`);
  for (const e of view.edges) lines.push(`  ${safe(e.from)} -->|${e.text}| ${safe(e.to)}`);
  return lines.join("\n");
}

export function renderDot(view: View): string {
  const lines = [`digraph "${view.title}" {`];
  for (const n of view.nodes) lines.push(`  ${safe(n.id)} [label="${n.text}"];`);
  for (const e of view.edges) lines.push(`  ${safe(e.from)} -> ${safe(e.to)} [label="${e.text}"];`);
  lines.push("}");
  return lines.join("\n");
}
