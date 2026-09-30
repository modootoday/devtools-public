#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadConfig, workDir } from "../config.js";
import { discoverCandidates } from "../discover.js";
import { parseArgs } from "./args.js";

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.repoRoot, args.flag("config"));
const outPath = args.flag("out", join(workDir(config), "candidates.jsonl"))!;

const candidates = discoverCandidates(args.repoRoot);

const full = resolve(args.repoRoot, outPath);
mkdirSync(dirname(full), { recursive: true });
writeFileSync(full, `${candidates.map((c) => JSON.stringify(c)).join("\n")}\n`);

const byDir: Record<string, number> = {};
for (const c of candidates) {
  const top = c.directory.split("/")[0] || ".";
  byDir[top] = (byDir[top] ?? 0) + 1;
}

console.log(`candidate documents ${candidates.length}`);
console.log(`with frontmatter    ${candidates.filter((c) => c.signals.hasFrontmatter).length}`);
console.log(`with a date prefix  ${candidates.filter((c) => c.signals.leadingDigits >= 8).length}`);
console.log(`with task boxes     ${candidates.filter((c) => c.signals.taskBoxes > 0).length}`);
console.log(`\nby top-level directory`);
for (const [dir, n] of Object.entries(byDir)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)) {
  console.log(`  ${String(n).padStart(5)}  ${dir}`);
}
console.log(`\nwritten to ${outPath}`);
console.log(
  "Nothing was classified. Which of these are design documents, and of what kind, is decided by reading them.",
);
