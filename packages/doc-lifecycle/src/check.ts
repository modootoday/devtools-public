// Schema, naming, placement and the page-to-code link. Computes findings and
// returns them; whether a finding blocks is the caller's to declare.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { exposureFindings } from "./exposure.js";
import { scan } from "./scan.js";
import type { CheckCode, CheckResult, Document, Finding, SpecConfig } from "./types.js";

export type CheckOptions = {
  /** Milliseconds since the epoch, for the reviewEveryDays comparison. */
  now?: number;
};

// A date a header writes as 20260906 or 2026-09-06. Anything else is not a
// date this can compare, and a comparison against a value it guessed at would
// report a document overdue on the strength of its own parsing.
function parseDay(value: string | string[] | undefined): number | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/-/g, "");
  if (!/^\d{8}/.test(digits)) return null;
  const at = Date.parse(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(at) ? null : at;
}

// "Status: accepted", "- Status: active", "> **Status:** design" and the like.
const BODY_STATUS = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*)?status(?:\*\*)?\s*(?:\*\*)?\s*:/im;

export function checkDocuments(
  repoRoot: string,
  config: SpecConfig,
  options: CheckOptions = {},
): CheckResult {
  const now = options.now ?? Date.now();
  const findings: Finding<CheckCode>[] = [];
  const add = (code: CheckCode, doc: Document | null, detail: string): void => {
    findings.push({ code, path: doc?.rel ?? "-", detail });
  };

  const { roots, documents } = scan(repoRoot, config);

  // A spec root inside a published path turns internal documents into public
  // ones. The hosting setting lives outside the repository, so a docs/ root is
  // refused whether or not a generator is detected: an unreadable setting is not
  // evidence of safety.
  findings.push(...exposureFindings(repoRoot, config, roots));

  // Ids are unique within a spec root, not across the repository: a package can
  // name a document what it likes, and a link resolves to the nearest one first.
  const byRoot = new Map<string, Map<string, string>>();

  for (const doc of documents) {
    // Chapters are parts of one document, not documents. They carry no id and
    // inherit their parent's header, so silence in one is correct.
    if (doc.isChapter) continue;

    // The scan only produces documents under a kind the configuration declares,
    // so this cannot miss; skipping rather than asserting keeps a hand-built
    // document list from crashing the checker.
    const spec = config.kinds[doc.declaredKind];
    if (!spec) continue;

    if (!doc.detectedKind) {
      add("FILENAME_SHAPE", doc, `does not match the ${doc.declaredKind} pattern ${spec.file}`);
    } else if (doc.detectedKind !== doc.declaredKind) {
      add("KIND_MISPLACED", doc, `named as ${doc.detectedKind} but placed under ${doc.declaredKind}`);
    }

    if (!byRoot.has(doc.specRoot)) byRoot.set(doc.specRoot, new Map());
    const seen = byRoot.get(doc.specRoot)!;
    if (seen.has(doc.id)) {
      add("ID_DUPLICATE", doc, `id "${doc.id}" is also ${seen.get(doc.id)} in this spec root`);
    } else seen.set(doc.id, doc.rel);

    const fm = doc.frontmatter;
    if (!fm) {
      add("NO_FRONTMATTER", doc, "no parseable frontmatter");
      // A document that states its status another way follows a different
      // convention; one that states it nowhere has no recorded decision at all.
      if (!BODY_STATUS.test(doc.text)) add("STATUS_ABSENT", doc, "no status in frontmatter or in the body");
      continue;
    }

    if (fm.kind && fm.kind !== doc.declaredKind) {
      add(
        "KIND_DISAGREES",
        doc,
        `frontmatter says ${String(fm.kind)}, filename and placement say ${doc.declaredKind}`,
      );
    }

    const declaredId = fm[spec.idField ?? "id"];
    if (declaredId && declaredId !== doc.id) {
      add("ID_DISAGREES", doc, `declared id "${String(declaredId)}" is not the filename stem "${doc.id}"`);
    }

    for (const field of spec.required) {
      // status has its own code below; reporting it twice makes an undecided
      // document look like two problems.
      if (field === "status") continue;
      if (fm[field] === undefined || fm[field] === "") add("FIELD_MISSING", doc, `required field: ${field}`);
    }

    // Undecided and wrong are different states and get different codes. A
    // migration leaves fields blank on purpose, and a blank one reported as a
    // bad value pushes the reader towards inventing a value to silence it.
    if (fm.status === "" || fm.status === undefined) {
      add("STATUS_UNDECIDED", doc, "nobody has decided this document's status");
    } else if (!spec.status.includes(fm.status as string)) {
      add("STATUS_UNKNOWN", doc, `"${String(fm.status)}" is not one of: ${spec.status.join(" · ")}`);
    }

    if (spec.domain === false) {
      if (doc.directoryDomain) add("DOMAIN_UNEXPECTED", doc, `${doc.declaredKind} takes no domain level`);
    } else {
      if (!doc.directoryDomain) add("DOMAIN_MISSING", doc, "no domain directory under the kind root");
      else if (fm.domain && fm.domain !== doc.directoryDomain) {
        add(
          "DOMAIN_DISAGREES",
          doc,
          `frontmatter domain "${String(fm.domain)}" is not directory "${doc.directoryDomain}"`,
        );
      }
      if (spec.domain.length > 0 && fm.domain && !spec.domain.includes(fm.domain as string)) {
        add("DOMAIN_UNKNOWN", doc, `"${String(fm.domain)}" is not one of: ${spec.domain.join(" · ")}`);
      }
    }

    // The page kind earns its existence here: a screen that was deleted or
    // renamed turns its document red without anyone noticing the drift.
    if (fm.implements) {
      const targets = Array.isArray(fm.implements) ? fm.implements : [fm.implements];
      for (const target of targets) {
        const base = doc.package === "." ? repoRoot : join(repoRoot, doc.package);
        const resolved = isAbsolute(target) ? join(repoRoot, target.slice(1)) : join(base, target);
        if (!existsSync(resolved)) add("IMPLEMENTS_MISSING", doc, `implements "${target}" does not exist`);
      }
    }

    // Confirming a document still holds must not require editing it, which is
    // why these are two fields.
    if (!fm.reviewed) {
      add("NEVER_REVIEWED", doc, "no reviewer has confirmed this document holds");
    } else if (fm.updated && String(fm.updated) > String(fm.reviewed)) {
      add("REVIEW_STALE", doc, `updated ${String(fm.updated)} is newer than reviewed ${String(fm.reviewed)}`);
    } else if (spec.reviewEveryDays !== null) {
      // The cadence a kind declares. Without this the field is configuration
      // nothing reads, and a document reviewed once counts as reviewed forever.
      const reviewedAt = parseDay(fm.reviewed);
      if (reviewedAt !== null) {
        const days = Math.floor((now - reviewedAt) / 86_400_000);
        if (days > spec.reviewEveryDays) {
          add(
            "REVIEW_OVERDUE",
            doc,
            `last reviewed ${days} days ago; ${doc.declaredKind} is reviewed every ${spec.reviewEveryDays}`,
          );
        }
      }
    }
  }

  return { roots, documents, findings };
}
