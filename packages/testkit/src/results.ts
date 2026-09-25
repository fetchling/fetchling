import type { CallToolResult } from "@fetchling/protocol";

/** The most common tool result: one block of text. */
export function textResult(text: string): CallToolResult {
  return { resultType: "complete", content: [{ type: "text", text }] };
}