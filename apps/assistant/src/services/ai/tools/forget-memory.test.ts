import { describe, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { SForgetMemoryArgs } from "./forget-memory";

describe("SForgetMemoryArgs", () => {
  test("requires unique positive integer fact IDs", () => {
    expect(compile(SForgetMemoryArgs, { formats }).check({ factIds: [1, 2] })).toBe(true);
    for (const factIds of [[], [1, 1], [0], [1.5]]) {
      expect(compile(SForgetMemoryArgs, { formats }).check({ factIds })).toBe(false);
    }
  });
});
