#!/usr/bin/env node
// Refuses a release that breaks this repository's rules: every package MIT,
// published public, carrying its LICENSE, shipping no source map, and depending
// only on packages anyone can already install.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const problems = [];
const packages = readdirSync(join(root, "packages")).filter((d) =>
  existsSync(join(root, "packages", d, "package.json")),
);

async function isPublic(name) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  return res.status === 200;
}

for (const dir of packages) {
  const at = join(root, "packages", dir);
  const pkg = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
  const label = pkg.name ?? dir;
  if (pkg.license !== "MIT") problems.push(`${label}: license is ${pkg.license}, not MIT`);
  if (pkg.publishConfig?.access !== "public") problems.push(`${label}: publishConfig.access is not public`);
  if (!existsSync(join(at, "LICENSE"))) problems.push(`${label}: no LICENSE file in the package`);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: at, encoding: "utf8" }),
  )[0];
  const maps = packed.files.filter((f) => f.path.endsWith(".map"));
  if (maps.length > 0) problems.push(`${label}: tarball ships ${maps.length} source map(s)`);
  if (!packed.files.some((f) => f.path === "LICENSE")) problems.push(`${label}: tarball lacks LICENSE`);
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  for (const dep of deps.filter((d) => d.startsWith("@modootoday/"))) {
    const sibling = packages.some((d) => {
      const p = join(root, "packages", d, "package.json");
      return JSON.parse(readFileSync(p, "utf8")).name === dep;
    });
    if (!sibling && !(await isPublic(dep))) problems.push(`${label}: depends on ${dep}, which is not public`);
  }
}

if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.exit(1);
}
process.stdout.write(`public release check: ${packages.length} package(s) pass\n`);
