# @modootoday/devtools-doc-lifecycle

Design-document conformance and migration: scan a document set, check schema, naming, placement and the page-to-code link, draw the reference graph, and carry a pile onto a convention through discover, cluster, derive and apply.

## Public surfaces

- `loadConfig`, `configForRoot`, `DEFAULTS`, `specDir`, `workDir` — the schema a repository declares in `spec-conformance.json`, and where a migration puts what it produces.
- `scan`, `findSpecRoots`, `parseFrontmatter`, `proseOnly`, `kindOf`, `idOf` — reading the document set. Parsing only; no judgement.
- `checkDocuments` — schema, naming, placement, the page-to-code link and the review cadence, as `CHECK_CODES` findings.
- `exposureFindings`, `shipsInTarball`, `parseGitmodules` — whether any discovered spec root would be published: under `docs/`, a publish signal, a configured `publicPaths` prefix, a public submodule named in the committed `visibilityManifest`, or an npm package whose `files` does not leave it out.
- `nextDecisionIds` — the next number in each decision series, derived from the documents.
- `preservedFields` (config) and `rawFieldLines` — frontmatter fields a migration copies verbatim, line for line, because the repository's own gates read them; without it, `apply` carries unknown fields into the body as prose.
- `buildGraph` takes an optional `fileExists`: a relation naming a repository file that still stands, such as a retired rule kept as a redirect stub, then resolves as a path rather than dangling. The CLI supplies it; a caller that does not gets the conservative reading.
- `buildGraph`, `graphView`, `renderMermaid`, `renderDot`, `loadHistory`, `namedPaths` — the reference graph, the invariants only a graph can see (`GRAPH_CODES`), and six scoped views.
- `discoverCandidates`, `clusterDocuments`, `deriveDossiers`, `applyDecisions`, `knownFields` — the migration pipeline, each stage a pure function over what the stage before it produced. A document whose header declares an id other than its filename stem (the kind's `idField`) is proposed under that id, because links name it that way; `apply` refuses a decision whose source changed after it was derived.

## Wiring

```ts
import { checkDocuments, loadConfig } from "@modootoday/devtools-doc-lifecycle";

const config = loadConfig(process.cwd());
const { documents, findings } = checkDocuments(process.cwd(), config);

const blocking = new Set(["ID_DUPLICATE", "PUBLISHED_ROOT"]);
const blocked = findings.filter((f) => blocking.has(f.code));
for (const f of blocked) console.error(`${f.code} ${f.path}: ${f.detail}`);

console.log(`${documents.length} documents, ${findings.length} findings`);
process.exit(blocked.length > 0 ? 1 : 0);
```

The same choice on the command line is `--fail-on`:

```
devtools-doc-check     <root> [--config f] [--json] [--all] [--fail-on <codes|any>]
devtools-doc-graph     <root> [--config f] [--view v] [--format mermaid|dot|json] [--findings]
devtools-doc-discover  <root> [--out f]
devtools-doc-cluster   <root> [--min n] [--subject s] [--json]
devtools-doc-derive    <root> [--classified f] [--into d] [--out f]
devtools-doc-apply     <root> [--dossier f] [--decisions f] [--write]
devtools-doc-next-adr  <root> [--config f] [--series ADR-TOOL-] [--json]
devtools-doc-visibility <root> [--config f] [--out f] [--write]   # asks GitHub via gh; run by an operator, never a gate
```

## Runtime and ownership boundary

The package reads a tree and returns findings, dossiers and rendered views. It installs no hook, chooses no severity, and touches a file only through `devtools-doc-apply --write`; the source pile is never modified either way.

Reporting is the default. `devtools-doc-check` exits 0 with findings unless `--fail-on` names codes, because a document set with findings is the normal starting state of a migration rather than the tool's failure, and a checker that failed on sight would be unrunnable in the repository it exists to help. A repository that has finished migrating names the codes it will not accept again, and only then is this a gate. `--fail-on` refuses a code the checker cannot emit rather than gating on nothing: in a hook config, a rule that never fires reads exactly like one that does.

`pathRoots` is empty by default and belongs to the consumer. The graph joins documents to history through the paths they name in backticks, and which top-level directories exist is the one thing about a repository this package cannot know. An empty list means no allowlist — an unmatched path costs only precision, because the edge comes from history either way. Measured on the reference repository: 89,104 commit edges with its eleven roots declared, 93,261 with none, and identical findings and document edges in both runs.

Everything else a repository decides arrives in `spec-conformance.json`: which kinds exist, what a filename of each kind looks like, which status words each accepts, which fields are required, whether a kind takes a domain level and from which closed list, how often each kind is reviewed, what the reference field is called and which aliases to read as well.

`rootOverrides` gives one spec root its own kind settings, keyed by that root's path from the repository root: `{ "rootOverrides": { "apps/brand/.spec": { "kinds": { "sot": { "file": "^(\\d{2,3})-(.+)\\.md$", "domain": false } }, "ignore": ["adr"] } } }`. Only the fields that differ are stated, because they merge over the repository kinds, and `ignore` adds to the repository list inside that root only. It exists for a root that arrived with its own naming, where renaming every document would break every link that names one. `scan` and `checkDocuments` honour it, and `configForRoot` returns the settings for any root. The migration stages (`derive`, `apply`) and `nextDecisionIds` still read the repository kinds.

## Mock and dry-run

`devtools-doc-apply` without `--write` is the dry run: it builds every normalised document, reports what was accepted and what was refused and why, and writes nothing.

The stages are pure functions over data, so a caller drives them without a repository on disk beyond the one being read. `deriveDossiers` returns dossiers rather than writing them, `applyDecisions` returns the file contents rather than the files, and `checkDocuments` takes `now` so a review-cadence finding is decided by a date instead of by when the process ran.

Do not mock git to test the pipeline. What a window contains is answered by history, and a fixture that answers it instead proves only that the fixture agrees with itself.

## Validation

`bun run typecheck && bun run test`. The pipeline suite builds a real repository with fixed commit dates, because the window logic must be decided by history rather than by how fast the test ran. Every document in that fixture is a defect that actually happened: a wikilink inside a fenced block, an inline empty list, a document opening with a horizontal rule, a relation written against a name a rename retired.

One suite runs the built command rather than the source. What ships is the build, and the thing worth proving there is the exit code — a checker that reports and always exits 0 is indistinguishable in a hook config from one that gates.
