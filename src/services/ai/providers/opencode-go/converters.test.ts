import { describe, expect, test } from "bun:test";
import { scheduleOnceTool } from "../../tools/schedule-once/definition";
import { convertToolsForOpencodeGo } from "./converters";

describe("convertToolsForOpencodeGo", () => {
  test("removes unsupported JSON Schema composition keywords", () => {
    const tools = convertToolsForOpencodeGo([scheduleOnceTool]);

    expect(tools[0]?.function.parameters).toEqual({
      type: "object",
      properties: scheduleOnceTool.function.parameters?.properties,
      required: ["name", "fireAt"],
    });
  });
});
