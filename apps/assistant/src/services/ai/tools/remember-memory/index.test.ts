import { describe, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { SRememberMemoryArgs } from ".";

describe("SRememberMemoryArgs", () => {
  test("accepts a fact with its source message", () => {
    expect(
      compile(SRememberMemoryArgs, { formats }).check({
        fact: "The user likes tea.",
        sourceMessage: "I like tea.",
        supersedesFactIds: [],
      }),
    ).toBe(true);
  });
});
