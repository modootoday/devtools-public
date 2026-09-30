#!/usr/bin/env node
import { clusterDocuments } from "../cluster.js";
import { loadConfig } from "../config.js";
import { scan } from "../scan.js";
import { exitAfterFlush, parseArgs } from "./args.js";

const args = parseArgs(process.argv.slice(2));

let config;
try {
  config = loadConfig(args.repoRoot, args.flag("config"));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const { documents } = scan(args.repoRoot, config);
const real = documents.filter((d) => !d.isChapter);
const minDocs = Number(args.flag("min", String(config.cluster.minDocuments)));
const clusters = clusterDocuments(documents, config.cluster, { minDocuments: minDocs });

const only = args.flag("subject");
const selected = only ? clusters.filter((c) => c.subject === only) : clusters;

if (args.has("json")) {
  console.log(JSON.stringify({ repoRoot: args.repoRoot, clusters: selected }, null, 2));
  await exitAfterFlush(0);
}

console.log(`documents ${real.length} · clusters of ${minDocs}+ documents: ${clusters.length}\n`);

for (const cluster of selected.slice(0, only ? 1 : 15)) {
  console.log(`cluster: ${cluster.subject}   ${cluster.documents} documents`);
  console.log(`  status declared     ${cluster.withStatus} / ${cluster.documents}`);
  console.log(`  supersede declared  ${cluster.withSupersede}`);
  console.log(`  touched in 90 days  ${cluster.recent}`);
  console.log(
    cluster.answerable
      ? "  → the current document can be identified from what is declared"
      : "  → cannot identify which document is current without reading them",
  );
  if (only) {
    console.log("");
    for (const m of [...cluster.members].sort((a, b) => a.ageDays - b.ageDays)) {
      console.log(`    ${String(m.status ?? "-").padEnd(12)} ${String(m.ageDays).padStart(4)}d  ${m.rel}`);
    }
  }
  console.log("");
}

if (!only && clusters.length > 15) {
  console.log(`… ${clusters.length - 15} more (--json, or --subject <name>)`);
}
