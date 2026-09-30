# devtools-public

Developer tools from modootoday, published under the MIT license.

| Package | What it does |
| --- | --- |
| [`@modootoday/devtools-doc-lifecycle`](packages/doc-lifecycle) | Design-document conformance and migration: scan a document set, check schema, naming and placement, draw the reference graph, and carry a pile onto a convention. |

## Rules for this repository

- **Every package here is public.** A package may depend only on packages that are already
  public; the release check refuses anything else.
- **Nothing ships unscreened.** Before a release, the tree and every tarball are screened for
  secrets and internal details, and a hit stops the release.
- **No source maps are published.**

## Development

```sh
bun install
bun run build
bun run test
```
