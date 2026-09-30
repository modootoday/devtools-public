// Groups documents that appear to share a subject, and shows what each group
// has declared about itself.
//
// It groups; it does not pick. Which document in a cluster is current is a
// judgement, and a tool that guesses reports an answer nobody checked.

import type { Cluster, ClusterPolicy, Document } from "./types.js";

export type ClusterOptions = {
  minDocuments?: number;
  /** Milliseconds since the epoch, for the age of each member. */
  now?: number;
};

// Three signals, deliberately shallow: filename tokens, heading vocabulary and
// link co-occurrence. Anything deeper starts inferring meaning, which is the
// step this tool refuses to take.
function tokensOf(doc: Document, policy: ClusterPolicy, stop: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stem = doc.id.replace(/^\d{4,14}[-_]?/, "");
  for (const token of stem.split(/[-_]/)) {
    if (token.length >= policy.minTokenLength && !stop.has(token)) out.add(token);
  }
  for (const line of doc.text.split("\n")) {
    if (!line.startsWith("#")) continue;
    for (const token of line.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)) {
      if (token.length >= policy.minTokenLength && !stop.has(token)) out.add(token);
    }
  }
  for (const match of doc.text.matchAll(/\[\[([a-z0-9-]+)\]\]/g)) out.add(`link:${match[1]}`);
  return out;
}

export function clusterDocuments(
  documents: readonly Document[],
  policy: ClusterPolicy,
  options: ClusterOptions = {},
): Cluster[] {
  const real = documents.filter((d) => !d.isChapter);
  const stop = new Set(policy.stopwords);
  const minDocs = options.minDocuments ?? policy.minDocuments;
  const now = options.now ?? Date.now();

  const bySubject = new Map<string, Document[]>();
  for (const doc of real) {
    for (const token of tokensOf(doc, policy, stop)) {
      if (!bySubject.has(token)) bySubject.set(token, []);
      bySubject.get(token)!.push(doc);
    }
  }

  // A token in most documents names no subject. Section words like "phase" or
  // "context" appear everywhere and would swamp the real clusters, so anything
  // above the cutoff is dropped rather than listed as a stopword one by one.
  const ceiling = Math.max(minDocs, Math.floor(real.length * policy.maxDocumentFrequency));
  for (const [token, docs] of [...bySubject.entries()]) {
    if (docs.length > ceiling) bySubject.delete(token);
  }

  const age = (doc: Document): number => Math.round((now - doc.mtime) / 86_400_000);

  return [...bySubject.entries()]
    .filter(([, docs]) => docs.length >= minDocs)
    .map(([subject, docs]) => {
      const withStatus = docs.filter((d) => d.frontmatter?.status).length;
      const withSupersede = docs.filter(
        (d) => d.frontmatter?.supersedes || d.frontmatter?.supersededBy,
      ).length;
      return {
        subject,
        documents: docs.length,
        withStatus,
        withSupersede,
        recent: docs.filter((d) => age(d) <= 90).length,
        // The whole point: can a reader tell which one is current without
        // reading all of them?
        answerable: withStatus === docs.length && withSupersede > 0,
        members: docs.map((d) => ({
          id: d.id,
          rel: d.rel,
          status: (d.frontmatter?.status as string) ?? null,
          ageDays: age(d),
        })),
      };
    })
    .sort((a, b) => b.documents - a.documents);
}
