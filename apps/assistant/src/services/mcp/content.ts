import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";

const MAX_RESULT_BYTES = 1024 * 1024;

export function mcpResult(result: CallToolResult): AgentToolResult<CallToolResult> {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RESULT_BYTES) {
    throw new Error("MCP result exceeds 1 MiB. Request a smaller page or a narrower query.");
  }
  if (result.isError) {
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text);
    throw new Error(`MCP tool failed: ${text.join("\n") || "Server returned an error result"}`);
  }
  const content: AgentToolResult<CallToolResult>["content"] = [];
  for (const part of result.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    } else if (part.type === "resource" && "text" in part.resource) {
      content.push({ type: "text", text: JSON.stringify(part.resource) });
    } else {
      content.push({ type: "text", text: describeContent(part) });
    }
  }
  if (result.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "MCP operation completed with no content." });
  }
  return { content, details: result };
}

function describeContent(part: ContentBlock): string {
  if (part.type === "audio") {
    return JSON.stringify({
      type: part.type,
      mimeType: part.mimeType,
      message: "Audio returned by MCP; this agent's tool-result interface cannot play audio.",
    });
  }
  if (part.type === "resource" && "blob" in part.resource) {
    return JSON.stringify({
      type: "resource",
      uri: part.resource.uri,
      mimeType: part.resource.mimeType,
      message: "Binary resource returned; retained in result details, not decoded as text.",
    });
  }
  return JSON.stringify(part);
}

export function mcpJsonResult(value: unknown): AgentToolResult<CallToolResult> {
  return mcpResult({ content: [{ type: "text", text: JSON.stringify(value) }] });
}
