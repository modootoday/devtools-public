export { CONFIG_FILE, DEFAULTS, configForRoot, loadConfig, specDir, workDir } from "./config.js";

export { findSpecRoots, idOf, kindOf, parseFrontmatter, proseOnly, scan } from "./scan.js";

export { checkDocuments } from "./check.js";
export { exposureFindings, parseGitmodules, shipsInTarball } from "./exposure.js";
export { nextDecisionIds } from "./next-id.js";
export type { NextId } from "./next-id.js";
export type { CheckOptions } from "./check.js";

export {
  buildGraph,
  graphView,
  loadHistory,
  namedPaths,
  nodeKey,
  renderDot,
  renderMermaid,
  VIEW_NAMES,
} from "./graph.js";
export type { BuildGraphOptions, ViewName, ViewOptions } from "./graph.js";

export {
  DEFAULT_DOC_EXTENSIONS,
  DEFAULT_SKIP_DIRS,
  discoverCandidates,
} from "./discover.js";
export type { DiscoverOptions } from "./discover.js";

export { clusterDocuments } from "./cluster.js";
export type { ClusterOptions } from "./cluster.js";

export { citationIndex, deriveDossiers, documentsFromClassification, historyIndex, pathCandidates } from "./derive.js";
export type { ClassificationRow, DeriveOptions } from "./derive.js";

export { applyDecisions, knownFields, rawFieldLines } from "./apply.js";
export type { ApplyInput } from "./apply.js";

export { CHECK_CODES, GRAPH_CODES } from "./types.js";
export type {
  ApplyResult,
  Candidate,
  CandidateSignals,
  CheckCode,
  CheckResult,
  Cluster,
  ClusterMember,
  ClusterPolicy,
  Commit,
  CommitCandidate,
  CommitEdge,
  Decision,
  DeriveSummary,
  Document,
  Dossier,
  Finding,
  Frontmatter,
  GraphCode,
  GraphEdge,
  GraphResult,
  KindSpec,
  PathCandidate,
  RejectedDecision,
  RootOverride,
  ScanResult,
  SpecConfig,
  SpecRoot,
  View,
  ViewEdge,
  ViewNode,
  WrittenDocument,
} from "./types.js";
