// Whether a spec root would be published. Plans and decisions record
// measurements and operator choices; once published they cannot be recalled, so
// every discovered root is tested, not only the configured one.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { CheckCode, Finding, SpecConfig, SpecRoot, VisibilityManifest } from "./types.js";

type PackageManifest = { private?: boolean; files?: unknown };

const toPosix = (path: string): string => path.split(sep).join("/");

const under = (rel: string, prefix: string): boolean => {
  const p = prefix.replace(/^\.\//, "").replace(/\/+$/, "");
  if (p === "" || p === ".") return false;
  return rel === p || rel.startsWith(`${p}/`);
};

export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function parseGitmodules(text: string): { path: string; url: string }[] {
  const out: { path: string; url: string }[] = [];
  let current: { path?: string; url?: string } = {};
  const flush = (): void => {
    if (current.path && current.url) out.push({ path: current.path, url: current.url });
    current = {};
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[submodule")) {
      flush();
      continue;
    }
    const match = /^(path|url)\s*=\s*(.+)$/.exec(line);
    if (match) current[match[1] as "path" | "url"] = match[2]!.trim();
  }
  flush();
  return out;
}

function nearestPackage(repoRoot: string, from: string): { dir: string; manifest: PackageManifest } | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        return { dir, manifest: JSON.parse(readFileSync(candidate, "utf8")) as PackageManifest };
      } catch {
        return null;
      }
    }
    if (dir === repoRoot) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// npm ships every file when `files` is absent, dot-directories included, so a
// root beside a publishable manifest is published unless `files` leaves it out.
export function shipsInTarball(manifest: PackageManifest, relFromPackage: string): boolean {
  if (manifest.private === true) return false;
  if (!Array.isArray(manifest.files)) return true;
  const entries = (manifest.files as unknown[]).filter((e): e is string => typeof e === "string");
  const norm = (e: string): string => e.replace(/^!/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  const matches = (e: string): boolean => {
    const n = norm(e);
    return (
      n === "." ||
      n === "*" ||
      n === "**" ||
      n === relFromPackage ||
      relFromPackage.startsWith(`${n}/`) ||
      n.startsWith(`${relFromPackage}/`)
    );
  };
  if (entries.some((e) => e.startsWith("!") && matches(e))) return false;
  return entries.some((e) => !e.startsWith("!") && matches(e));
}

export function exposureFindings(
  repoRoot: string,
  config: SpecConfig,
  roots: readonly SpecRoot[],
): Finding<CheckCode>[] {
  const findings: Finding<CheckCode>[] = [];

  // The configured root is tested even before it exists: refusing a location
  // is cheaper than moving documents out of it after a publish.
  const configured = join(repoRoot, config.root);
  const candidates = roots.some((r) => r.path === configured)
    ? [...roots]
    : [...roots, { path: configured, package: "." }];

  let manifest: VisibilityManifest | null = null;
  if (config.visibilityManifest) {
    const manifestPath = join(repoRoot, config.visibilityManifest);
    const gitmodules = join(repoRoot, ".gitmodules");
    const current = sha256(existsSync(gitmodules) ? readFileSync(gitmodules) : "");
    if (!existsSync(manifestPath)) {
      findings.push({
        code: "VISIBILITY_STALE",
        path: config.visibilityManifest,
        detail: "no visibility manifest; run devtools-doc-visibility --write",
      });
    } else {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as VisibilityManifest;
      if (manifest.gitmodulesSha256 !== current) {
        findings.push({
          code: "VISIBILITY_STALE",
          path: config.visibilityManifest,
          detail: ".gitmodules changed after the manifest was written; run devtools-doc-visibility --write",
        });
      }
    }
  }

  const signals = config.publishSignals
    .filter((signal) => existsSync(join(repoRoot, signal)))
    .map((signal) => ({ signal, dir: signal.includes("/") ? (signal.split("/")[0] ?? ".") : "." }))
    .filter((s) => s.dir !== ".");

  for (const root of candidates) {
    const rel = toPosix(relative(repoRoot, root.path));
    const label = rel || ".";
    const refuse = (detail: string): void => {
      findings.push({ code: "PUBLISHED_ROOT", path: label, detail });
    };

    if (rel === "docs" || rel.startsWith("docs/")) {
      refuse("under docs/, a GitHub Pages publishing source; Pages can serve a private repository's files publicly");
    }
    for (const { signal, dir } of signals) {
      if (under(rel, dir)) refuse(`${signal} publishes ${dir}/, which contains this spec root`);
    }
    for (const prefix of config.publicPaths) {
      if (under(rel, prefix)) refuse(`${prefix} is published by this repository (publicPaths)`);
    }
    for (const [path, entry] of Object.entries(manifest?.submodules ?? {})) {
      if (entry.visibility.toUpperCase() === "PUBLIC" && under(rel, path)) {
        refuse(`inside ${path}, a public repository (${entry.url})`);
      }
    }
    if (rel !== "") {
      const pkg = nearestPackage(repoRoot, dirname(root.path));
      if (pkg && shipsInTarball(pkg.manifest, toPosix(relative(pkg.dir, root.path)))) {
        const pkgRel = toPosix(relative(repoRoot, pkg.dir)) || ".";
        refuse(`${pkgRel}/package.json is publishable and its files do not leave this root out`);
      }
    }
  }
  return findings;
}
