#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { nextDecisionIds } from "../next-id.js";
import { scan } from "../scan.js";
import { parseArgs } from "./args.js";

const args = parseArgs(process.argv.slice(2));

let config;
try {
  config = loadConfig(args.repoRoot, args.flag("config"));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const { documents } = scan(args.repoRoot, config);
const series = nextDecisionIds(documents, config);
const wanted = args.flag("series");

if (wanted) {
  const hit = series.find((s) => s.prefix === wanted);
  if (!hit) {
    console.error(`no decision in series "${wanted}"; known: ${series.map((s) => s.prefix).join(" · ") || "none"}`);
    process.exit(2);
  }
  console.log(hit.next);
  process.exit(0);
}

if (args.has("json")) {
  console.log(JSON.stringify(series, null, 2));
} else {
  for (const s of series) console.log(`${(s.prefix || "(unprefixed)").padEnd(16)} last ${s.last}   next ${s.next}`);
}
