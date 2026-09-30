#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { applyDecisions } from "../apply.js";
import { loadConfig, workDir } from "../config.js";
import type { Decision, Dossier } from "../types.js";
import { parseArgs } from "./args.js";

const args = parseArgs(process.argv.slice(2));
const write = args.has("write");
const config = loadConfig(args.repoRoot, args.flag("config"));
const work = workDir(config);

const readJsonl = <T,>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

let dossiers: Dossier[];
let decisions: Decision[];
try {
  dossiers = readJsonl<Dossier>(join(args.repoRoot, args.flag("dossier", join(work, "dossier.jsonl"))!));
  decisions = readJsonl<Decision>(
    join(args.repoRoot, args.flag("decisions", join(work, "decisions.jsonl"))!),
  );
} catch (error) {
  console.error(`${(error as Error).message}\nRun derive first, then record decisions.`);
  process.exit(2);
}

const { written, rejected } = applyDecisions({ repoRoot: args.repoRoot, config, dossiers, decisions });

if (write) {
  for (const item of written) {
    const full = join(args.repoRoot, item.to);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, item.text);
  }
}

console.log(`decisions read     ${decisions.length}`);
console.log(`accepted           ${written.length}`);
console.log(`rejected           ${rejected.length}`);
for (const r of rejected.slice(0, 15)) console.log(`  ${r.source}\n    ${r.why}`);
if (rejected.length > 15) console.log(`  … ${rejected.length - 15} more`);
console.log(
  write
    ? "\nwritten. The source pile was not touched."
    : "\nNothing was written; pass --write. The source pile is never modified either way.",
);
