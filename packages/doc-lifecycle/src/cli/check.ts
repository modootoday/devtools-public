#!/usr/bin/env node
import { checkDocuments } from "../check.js";
import { loadConfig } from "../config.js";
import { CHECK_CODES } from "../types.js";
import { exitAfterFlush, exitCodeFor, failingCodes, parseArgs, unknownCodes } from "./args.js";

const args = parseArgs(process.argv.slice(2));

let config;
try {
  config = loadConfig(args.repoRoot, args.flag("config"));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const gate = failingCodes(args.flag("fail-on"));
const unknown = unknownCodes(gate, CHECK_CODES);
if (unknown.length > 0) {
  console.error(`--fail-on names codes this checker cannot emit: ${unknown.join(", ")}`);
  console.error(`known codes: ${CHECK_CODES.join(" · ")}`);
  process.exit(2);
}

const { roots, documents, findings } = checkDocuments(args.repoRoot, config);
const real = documents.filter((d) => !d.isChapter);
const counts: Record<string, number> = {};
for (const f of findings) counts[f.code] = (counts[f.code] ?? 0) + 1;

if (args.has("json")) {
  console.log(
    JSON.stringify(
      {
        repoRoot: args.repoRoot,
        config: config.source,
        specRoots: roots.length,
        documents: real.length,
        counts,
        findings,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`spec roots ${roots.length}   (config: ${config.source})`);
  console.log(`documents  ${real.length}   (+ ${documents.length - real.length} chapters)`);
  const byKind: Record<string, number> = {};
  for (const d of real) byKind[d.declaredKind] = (byKind[d.declaredKind] ?? 0) + 1;
  const kinds = Object.entries(byKind)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  console.log(`by kind    ${kinds || "none"}`);
  console.log(`findings   ${findings.length}`);
  for (const [code, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(18)} ${n}`);
  }
  const shown = args.has("all") ? findings : findings.slice(0, 20);
  if (shown.length > 0) console.log("");
  for (const f of shown) console.log(`  ${f.code.padEnd(18)} ${f.path}\n${" ".repeat(21)}${f.detail}`);
  if (findings.length > shown.length) console.log(`\n  … ${findings.length - shown.length} more (--all)`);
}

await exitAfterFlush(exitCodeFor(findings, gate));
