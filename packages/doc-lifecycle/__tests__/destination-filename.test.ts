import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { destinationFilename } from "../src/derive.js";

const sot = { ...DEFAULTS.kinds["sot"]!, idField: "sot" };

describe("the filename a migrated document is proposed under", () => {
  it("is the declared id with the source's suffix", () => {
    expect(destinationFilename({ id: "_brands", filename: "_brands.sot.md" }, sot, { sot: "brand-roster" })).toBe(
      "brand-roster.sot.md",
    );
  });

  it("takes the kind's suffix when the source was named outside the convention", () => {
    expect(destinationFilename({ id: "SOT_FORMAT", filename: "SOT_FORMAT.md" }, sot, { sot: "sot-format" })).toBe(
      "sot-format.sot.md",
    );
  });

  it("keeps the source's name when the declared id cannot be a filename of the kind", () => {
    expect(destinationFilename({ id: "layout", filename: "layout.sot.md" }, sot, { sot: "Not An Id" })).toBe(
      "layout.sot.md",
    );
  });

  it("keeps the source's name when nothing else is declared", () => {
    expect(destinationFilename({ id: "layout", filename: "layout.sot.md" }, sot, {})).toBe("layout.sot.md");
  });
});
