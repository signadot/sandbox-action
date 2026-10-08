import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as yaml from "js-yaml";
import { toYAML } from "../src/doc";

// toYAML writes what the CLI reads, and the CLI reads YAML 1.1, where more plain
// scalars are numbers or bools than in the YAML 1.2 js-yaml speaks.

describe("toYAML", () => {
  it("quotes every string YAML 1.1 would read as a bool or a number", () => {
    const lookalikes = [
      // Bools in YAML 1.1 only.
      "yes",
      "No",
      "on",
      "OFF",
      "y",
      "n",
      // Numbers with underscores, which YAML 1.2 does not have.
      "1_000",
      "0_7",
      "685_230.15",
      "-1_0",
      "0x_1f",
      "0b1_0",
      "0o_7",
      "0o1_7",
      // Numbers in both, or in the CLI's reading of 1.1.
      "1e3",
      "012",
      "0o17",
      ".5",
      "1.",
      "12:30",
      ".inf",
      ".NaN",
      // Nulls and dates.
      "~",
      "null",
      "2001-01-01",
    ];
    for (const v of lookalikes) {
      const out = toYAML({ v });
      assert.match(out, /^v: (['"]).*\1\n$/, `${v} came out as ${out}`);
      assert.equal((yaml.load(out) as { v: unknown }).v, v);
    }
  });

  it("leaves a string that is plainly a string unquoted", () => {
    for (const v of ["debug", "ghcr.io/acme/route:abc1234", "abc1234", "route-12", "v1.2.3"]) {
      assert.equal(toYAML({ v }), `v: ${v}\n`);
    }
  });

  it("writes numbers and bools that really are ones unquoted", () => {
    assert.equal(toYAML({ count: 1000, enabled: true }), "count: 1000\nenabled: true\n");
  });
});
