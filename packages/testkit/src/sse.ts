/**
 * Minimal Server-Sent Events framing: enough for MCP, where every event is one
 * JSON-RPC message in a `data` field. Comment lines (`:`) are keep-alives and are
 * ignored, as streamable-http.md requires of clients.
 */

/** One message as an SSE event. JSON.stringify output has no newlines, but guard anyway. */
export function sseEvent(data: string): string {
  return `${data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;
}

/** A keep-alive: an SSE comment line, which clients must ignore. */
export const SSE_KEEP_ALIVE = ":\n\n";

/**
 * Incremental parser: feed text chunks as they arrive, get back the `data` of every
 * complete event. Handles CRLF, LF and CR line endings and events split across chunks.
 */
export function createSseParser(): {
  push(chunk: string): string[];
  flush(): string[];
} {
  let buffer = "";
  let data: string[] = [];
  let sawData = false;

  const takeLines = (final: boolean): string[] => {
    const events: string[] = [];
    // A trailing "\r" may be the first half of "\r\n" — wait for more unless final.
    const pattern = /\r\n|\n|\r(?!$)/;
    for (;;) {
      const match = pattern.exec(buffer);
      if (!match) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (sawData) events.push(data.join("\n"));
        data = [];
        sawData = false;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") {
          data.push(value);
          sawData = true;
        }
      }
    }
    if (final) {
      if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
      if (buffer !== "" && buffer.startsWith("data")) {
        const colon = buffer.indexOf(":");
        let value = colon === -1 ? "" : buffer.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        data.push(value);
        sawData = true;
      }
      buffer = "";
      if (sawData) events.push(data.join("\n"));
      data = [];
      sawData = false;
    }
    return events;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return takeLines(false);
    },
    flush() {
      return takeLines(true);
    },
  };
}
