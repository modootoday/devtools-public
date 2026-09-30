import { resolve } from "node:path";

import type { Finding } from "../types.js";

export type Args = {
  repoRoot: string;
  has: (name: string) => boolean;
  flag: (name: string, fallback?: string | null) => string | null;
};

export function parseArgs(argv: readonly string[]): Args {
  const repoRoot = resolve(argv.find((a) => !a.startsWith("-")) ?? process.cwd());
  return {
    repoRoot,
    has: (name) => argv.includes(`--${name}`),
    flag: (name, fallback = null) => {
      const i = argv.indexOf(`--${name}`);
      return i === -1 ? fallback : (argv[i + 1] ?? fallback);
    },
  };
}

// A pipe drains asynchronously, so exiting straight after a large write cuts
// the output at the pipe buffer (64 KiB) while still reporting success.
export async function exitAfterFlush(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}

/**
 * Which finding codes make the process exit non-zero. Reporting stays the
 * default: a document set with findings is the normal starting state of a
 * migration, not the tool's failure. A repository that has finished migrating
 * names the codes it will not accept again, and only then is this a gate.
 */
export function failingCodes(spec: string | null): { any: boolean; codes: Set<string> } {
  if (!spec) return { any: false, codes: new Set() };
  const parts = spec
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (parts.includes("ANY")) return { any: true, codes: new Set() };
  return { any: false, codes: new Set(parts) };
}

export function exitCodeFor(
  findings: readonly Finding[],
  gate: { any: boolean; codes: Set<string> },
): number {
  if (gate.any) return findings.length > 0 ? 1 : 0;
  if (gate.codes.size === 0) return 0;
  return findings.some((f) => gate.codes.has(f.code)) ? 1 : 0;
}

export function unknownCodes(
  gate: { any: boolean; codes: Set<string> },
  known: readonly string[],
): string[] {
  if (gate.any) return [];
  return [...gate.codes].filter((c) => !known.includes(c));
}
