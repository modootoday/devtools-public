#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadConfig, workDir } from "../config.js";
import { deriveDossiers } from "../derive.js";
import type { ClassificationRow } from "../derive.js";
import { parseArgs } from "./args.js";

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.repoRoot, args.flag("config"));
const work = workDir(config);
const outPath = args.flag("out", join(work, "dossier.jsonl"))!;

const classifiedAt = resolve(
  args.repoRoot,
  args.flag("classified", join(work, "classifications.jsonl"))!,
);

let classifications: ClassificationRow[] | undefined;
if (existsSync(classifiedAt)) {
  classifications = readFileSync(classifiedAt, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ClassificationRow);
  console.log(`reading classification  ${classifications.length} rows the reading pass produced`);
}

const { dossiers, summary } = deriveDossiers(args.repoRoot, config, {
  classifications,
  into: args.flag("into") ?? undefined,
});

const full = resolve(args.repoRoot, outPath);
mkdirSync(dirname(full), { recursive: true });
writeFileSync(full, `${dossiers.map((d) => JSON.stringify(d)).join("\n")}\n`);

console.log(`documents               ${dossiers.length}`);
console.log(`created date recovered  ${summary.withCreated}`);
console.log(`status already usable   ${summary.statusUsable}`);
console.log(`status is free text     ${summary.statusFreeText}   (moved to the reading pass, not mapped)`);
console.log(`relationships declared  ${summary.withDeclared}`);
console.log(`needs reading           ${summary.needsReading}`);
console.log(`\ndossier written to ${outPath}`);
console.log("Nothing was normalised. A document set is decided by reading it, not by this script.");
