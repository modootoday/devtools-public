export type KindSpec = {
  dir: string;
  sourceDirs?: readonly string[];
  file: string;
  required: readonly string[];
  idField?: string;
  status: readonly string[];
  domain: false | readonly string[];
  reviewEveryDays: number | null;
  allowDirectoryForm?: boolean;
};

export type ClusterPolicy = {
  stopwords: readonly string[];
  minTokenLength: number;
  minDocuments: number;
  maxDocumentFrequency: number;
};

export type SpecConfig = {
  root: string;
  kinds: Record<string, KindSpec>;
  ignore: readonly string[];
  reserved: readonly string[];
  publishSignals: readonly string[];
  referenceField: string;
  referenceAliases: readonly string[];
  /**
   * Top-level directories a document may name a path into. Repository-specific:
   * a shipped default would make every consumer's tree look like ours.
   */
  pathRoots: readonly string[];
  /**
   * Directory prefixes the repository publishes by other means, such as a
   * public mirror. A spec root under one of them is refused.
   */
  publicPaths: readonly string[];
  /**
   * A committed record of which submodules are public, written by
   * devtools-doc-visibility. Read offline: a gate that asks the network fails
   * for reasons unrelated to the change being checked.
   */
  visibilityManifest: string | null;
  /**
   * Frontmatter fields a migration copies verbatim from the original header.
   * A repository's own gates read fields this schema does not know; carrying
   * them into the body as prose keeps the words and loses the field.
   */
  preservedFields: readonly string[];
  /**
   * Kind and ignore settings for one spec root, keyed by its path from the
   * repository root. A root that arrived with its own naming keeps it instead of
   * renaming every document and link it has.
   */
  rootOverrides?: Record<string, RootOverride>;
  cluster: ClusterPolicy;
  source: string;
};

export type RootOverride = {
  kinds?: Record<string, Partial<KindSpec>>;
  /** Added to the repository ignore list inside this root only. */
  ignore?: readonly string[];
};

export type VisibilityManifest = {
  /** sha256 of .gitmodules when the record was taken; a mismatch means stale. */
  gitmodulesSha256: string;
  measuredAt: string;
  submodules: Record<string, { url: string; visibility: string }>;
};

export type FrontmatterValue = string | string[];

// The fields this schema knows, plus whatever else the author wrote. Naming the
// known ones is what lets a reader see the vocabulary in the type instead of
// finding it spread across the checks.
export type Frontmatter = {
  kind?: FrontmatterValue;
  id?: FrontmatterValue;
  domain?: FrontmatterValue;
  status?: FrontmatterValue;
  created?: FrontmatterValue;
  updated?: FrontmatterValue;
  reviewed?: FrontmatterValue;
  supersedes?: FrontmatterValue;
  supersededBy?: FrontmatterValue;
  references?: FrontmatterValue;
  implements?: FrontmatterValue;
  source?: FrontmatterValue;
  title?: FrontmatterValue;
  [key: string]: FrontmatterValue | undefined;
};

export type SpecRoot = { path: string; package: string };

export type Document = {
  path: string;
  rel: string;
  filename: string;
  specRoot: string;
  package: string;
  declaredKind: string;
  detectedKind: string | null;
  id: string;
  isChapter: boolean;
  chapterOf: string | null;
  directoryDomain: string | null;
  frontmatter: Frontmatter | null;
  text: string;
  lines: number;
  mtime: number;
};

export type ScanResult = { roots: SpecRoot[]; documents: Document[] };

export const CHECK_CODES = [
  "PUBLISHED_ROOT",
  "VISIBILITY_STALE",
  "FILENAME_SHAPE",
  "KIND_MISPLACED",
  "ID_DUPLICATE",
  "NO_FRONTMATTER",
  "STATUS_ABSENT",
  "KIND_DISAGREES",
  "ID_DISAGREES",
  "FIELD_MISSING",
  "STATUS_UNDECIDED",
  "STATUS_UNKNOWN",
  "DOMAIN_UNEXPECTED",
  "DOMAIN_MISSING",
  "DOMAIN_DISAGREES",
  "DOMAIN_UNKNOWN",
  "IMPLEMENTS_MISSING",
  "NEVER_REVIEWED",
  "REVIEW_STALE",
  "REVIEW_OVERDUE",
] as const;

export const GRAPH_CODES = [
  "LINK_DANGLING",
  "LINK_AMBIGUOUS",
  "SUPERSEDE_DANGLING",
  "SUPERSEDE_ONE_SIDED",
  "SUCCESSOR_MISSING",
  "REF_DANGLING",
  "SUPERSEDE_CYCLE",
] as const;

export type CheckCode = (typeof CHECK_CODES)[number];
export type GraphCode = (typeof GRAPH_CODES)[number];

export type Finding<Code extends string = string> = {
  code: Code;
  path: string;
  detail: string;
};

export type CheckResult = {
  roots: SpecRoot[];
  documents: Document[];
  findings: Finding<CheckCode>[];
};

export type GraphEdge = { from: Document; to: Document; type: "link" | "supersedes" | "ref" };

export type Commit = { hash: string; at: number; subject: string; paths: string[] };

export type CommitEdge = { doc: Document; path: string | null; commit: Commit; cited?: boolean };

export type GraphResult = {
  documents: Document[];
  nodes: Map<string, Document>;
  edges: GraphEdge[];
  commitEdges: CommitEdge[];
  findings: Finding<GraphCode>[];
};

export type ViewNode = { id: string; text: string };
export type ViewEdge = { from: string; to: string; text: string };
export type View = { title: string; nodes: ViewNode[]; edges: ViewEdge[] };

export type CandidateSignals = {
  bytes: number;
  lines: number;
  leadingDigits: number;
  hasFrontmatter: boolean;
  frontmatterKeys: string[];
  title: string | null;
  headings: string[];
  taskBoxes: number;
  wikilinks: string[];
  created: string | null;
  updated: string | null;
};

export type Candidate = {
  path: string;
  directory: string;
  filename: string;
  signals: CandidateSignals;
  classification: null;
};

export type ClusterMember = {
  id: string;
  rel: string;
  status: string | null;
  ageDays: number;
};

export type Cluster = {
  subject: string;
  documents: number;
  withStatus: number;
  withSupersede: number;
  recent: number;
  answerable: boolean;
  members: ClusterMember[];
};

export type PathCandidate = {
  token: string;
  line: number;
  context: string;
  exists: boolean;
  touchedAfter: boolean;
};

export type CommitCandidate = { on: string | null; subject: string; path: string };

export type Dossier = {
  source: string;
  package: string;
  derived: {
    kind: string;
    id: string;
    domain: string | null;
    created: string | null;
    updated: string | null;
    renamedFrom: string | null;
    lines: number;
    chapters: string[];
  };
  declared: { status: string | null; supersedes: string[]; references: string[] };
  originalFrontmatter: Frontmatter;
  // Absent on dossiers derived before 0.3.0; apply then cannot tell a stale one.
  sourceSha256?: string;
  unknown: { field: string; why: string }[];
  evidence: {
    commits: { on: string | null; subject: string }[];
    headings: string[];
  };
  implementation: {
    commitSearch: {
      window: { opened: string | null; closed: string | null; days: number | null };
      scope: "none" | "in-window" | "widened-past-window";
      widenedBecause: string | null;
      counts: { inWindow: number; afterWindow: number };
      candidates: CommitCandidate[];
    };
    pathCandidates: PathCandidate[];
    candidatesPresent: number;
    candidatesTouchedAfterWriting: number;
    commitsCitingSlug: { on: string | null; subject: string }[];
    tasks: { done: number; open: number };
  };
  proposedPath: string;
};

export type DeriveSummary = {
  withCreated: number;
  statusUsable: number;
  statusFreeText: number;
  withDeclared: number;
  needsReading: number;
};

export type Decision = {
  source: string;
  kind?: string;
  path?: string;
  status?: string;
  supersedes?: string[];
  supersededBy?: string[];
  references?: string[];
  frontmatter?: Record<string, string | string[] | null | undefined>;
  evidence?: string;
};

export type WrittenDocument = { from: string; to: string; text: string };
export type RejectedDecision = { source: string; why: string };
export type ApplyResult = { written: WrittenDocument[]; rejected: RejectedDecision[] };
