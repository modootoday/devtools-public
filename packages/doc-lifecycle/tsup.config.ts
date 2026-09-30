import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/check.ts",
    "src/cli/graph.ts",
    "src/cli/discover.ts",
    "src/cli/cluster.ts",
    "src/cli/derive.ts",
    "src/cli/apply.ts",
    "src/cli/next-adr.ts",
    "src/cli/visibility.ts",
  ],
  format: ["esm"],
  target: "node20",
  treeshake: false,
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
    },
  },
  clean: true,
  // Source maps would publish every comment verbatim; the public package ships none.
  sourcemap: false,
});
