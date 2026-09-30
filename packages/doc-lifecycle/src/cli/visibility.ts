#!/usr/bin/env node
// Writes the visibility manifest the checker reads offline. This is the one
// place that asks the network, and an operator runs it, never a gate.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { parseGitmodules, sha256 } from "../exposure.js";
import type { VisibilityManifest } from "../types.js";
import { exitAfterFlush, parseArgs } from "./args.js";

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.repoRoot, args.flag("config"));
const out = args.flag("out") ?? config.visibilityManifest;
if (!out) {
  console.error("no destination: set visibilityManifest in the config or pass --out <path>");
  process.exit(2);
}

const gitmodulesPath = join(args.repoRoot, ".gitmodules");
const text = existsSync(gitmodulesPath) ? readFileSync(gitmodulesPath, "utf8") : "";
const submodules: VisibilityManifest["submodules"] = {};
for (const { path, url } of parseGitmodules(text)) {
  const repo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
  if (!repo) {
    console.error(`${path}: ${url} is not a GitHub URL; visibility cannot be read`);
    process.exit(1);
  }
  const visibility = execFileSync("gh", ["repo", "view", repo, "--json", "visibility", "-q", ".visibility"], {
    encoding: "utf8",
  }).trim();
  submodules[path] = { url, visibility };
}

const manifest: VisibilityManifest = {
  gitmodulesSha256: sha256(text),
  measuredAt: new Date().toISOString(),
  submodules,
};

const publicCount = Object.values(submodules).filter((s) => s.visibility.toUpperCase() === "PUBLIC").length;
if (!args.has("write")) {
  console.log(JSON.stringify(manifest, null, 2));
  console.error(`${Object.keys(submodules).length} submodules, ${publicCount} public; pass --write to save ${out}`);
  await exitAfterFlush(0);
}
writeFileSync(join(args.repoRoot, out), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out}: ${Object.keys(submodules).length} submodules, ${publicCount} public`);
