#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { buildGraph, graphView, loadHistory, renderDot, renderMermaid, VIEW_NAMES } from "../graph.js";
import type { ViewName } from "../graph.js";
import { scan } from "../scan.js";
import { GRAPH_CODES } from "../types.js";
import { exitAfterFlush, exitCodeFor, failingCodes, parseArgs, unknownCodes } from "./args.js";

const args = parseArgs(process.argv.slice(2));

let config;
try {
  config = loadConfig(args.repoRoot, args.flag("config"));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const view = (args.flag("view", "domains") ?? "domains") as ViewName;
if (!VIEW_NAMES.includes(view)) {
  console.error(`unknown view "${view}" (${VIEW_NAMES.join(" · ")})`);
  process.exit(2);
}

const gate = failingCodes(args.flag("fail-on"));
const unknown = unknownCodes(gate, GRAPH_CODES);
if (unknown.length > 0) {
  console.error(`--fail-on names codes this graph cannot emit: ${unknown.join(", ")}`);
  console.error(`known codes: ${GRAPH_CODES.join(" · ")}`);
  process.exit(2);
}

const { documents } = scan(args.repoRoot, config);
const history = args.has("no-history") ? [] : loadHistory(args.repoRoot);
const fileExists = (repoPath: string): boolean => existsSync(join(args.repoRoot, repoPath));
const result = buildGraph(documents, config, { history, fileExists });

if (args.has("findings")) {
  const counts: Record<string, number> = {};
  for (const f of result.findings) counts[f.code] = (counts[f.code] ?? 0) + 1;
  console.log(
    `nodes ${result.documents.length} · document edges ${result.edges.length} · commit edges ${result.commitEdges.length} · findings ${result.findings.length}`,
  );
  for (const [code, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(20)} ${n}`);
  }
  for (const f of result.findings.slice(0, 20)) console.log(`\n  ${f.code}  ${f.path}\n    ${f.detail}`);
  await exitAfterFlush(exitCodeFor(result.findings, gate));
}

let drawn;
try {
  drawn = graphView(result, config, view, {
    id: args.flag("id"),
    depth: Number(args.flag("depth", "2")),
    kind: args.flag("kind", "sot") ?? "sot",
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const format = args.flag("format", "mermaid");
if (format === "json") {
  console.log(
    JSON.stringify(
      { view: drawn.title, nodes: drawn.nodes, edges: drawn.edges, findings: result.findings },
      null,
      2,
    ),
  );
} else if (format === "dot") {
  console.log(renderDot(drawn));
} else {
  console.log(renderMermaid(drawn));
}

await exitAfterFlush(exitCodeFor(result.findings, gate));
