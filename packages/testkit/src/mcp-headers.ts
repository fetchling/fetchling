/**
 * Streamable HTTP request-metadata headers (streamable-http.md § Request Metadata):
 * the standard headers, `x-mcp-header` parameter mirroring, Base64 sentinel value
 * encoding, and server-side validation of headers against the body.
 *
 * Pure logic with no I/O. It lives in testkit for now because both the fake servers and
 * the raw client need it; fetchling's own server and upstream packages need exactly the
 * same rules in Phase 4 (plan D18), at which point it moves to @fetchling/core. The only
 * Node API used is Buffer, for Base64.
 */
import type { Tool } from "@fetchling/protocol";
import { isObject, type JsonObject, metaValue } from "./json.js";

export const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
export const METHOD_HEADER = "mcp-method";
export const NAME_HEADER = "mcp-name";
export const PARAM_HEADER_PREFIX = "mcp-param-";

/** Methods whose `Mcp-Name` header is required, and the body field it mirrors. */
const NAME_SOURCES: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

// RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
// "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII, space and horizontal tab: what a header value may contain unencoded.
const SAFE_VALUE = /^[\t\x20-\x7e]*$/;

/**
 * Encode a value for a header (§ Value Encoding). Plain ASCII passes through; anything
 * with non-ASCII or control characters, leading/trailing whitespace, or a value that
 * itself looks like the sentinel is sent as `=?base64?<utf-8 base64>?=`.
 */
export function encodeHeaderValue(value: string): string {
  const plainIsSafe =
    SAFE_VALUE.test(value) &&
    value === value.trim() &&
    !(value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX));
  if (plainIsSafe) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

export type Decoded = { ok: true; value: string } | { ok: false; reason: string };

/** Decode a header value, undoing the Base64 sentinel if present. */
export function decodeHeaderValue(raw: string): Decoded {
  if (raw.startsWith(SENTINEL_PREFIX) && raw.endsWith(SENTINEL_SUFFIX)) {
    const body = raw.slice(SENTINEL_PREFIX.length, raw.length - SENTINEL_SUFFIX.length);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) {
      return { ok: false, reason: "invalid Base64 in sentinel-encoded value" };
    }
    const bytes = Buffer.from(body, "base64");
    const value = bytes.toString("utf8");
    // Round-trip check rejects byte sequences that are not valid UTF-8.
    if (!Buffer.from(value, "utf8").equals(bytes)) {
      return { ok: false, reason: "sentinel-encoded value is not valid UTF-8" };
    }
    return { ok: true, value };
  }
  if (!SAFE_VALUE.test(raw))
    return { ok: false, reason: "header value contains invalid characters" };
  return { ok: true, value: raw };
}

// ── x-mcp-header ────────────────────────────────────────────────────────────────

export type ParamType = "string" | "integer" | "boolean";

/** One `x-mcp-header` marker that passed validation. */
export interface ParamHeaderSpec {
  /** The name part of `Mcp-Param-{name}`, as declared (header names compare case-insensitively). */
  name: string;
  /** Chain of `properties` keys from the schema root to the marked property. */
  path: string[];
  type: ParamType;
}

export type ScanResult =
  | { ok: true; params: ParamHeaderSpec[] }
  | { ok: false; reason: string };

const MARKER = "x-mcp-header";

/**
 * Validate every `x-mcp-header` marker in an input schema (tools.md § x-mcp-header,
 * streamable-http.md § Schema Extension). Any violation makes the whole tool invalid:
 * an HTTP client must then leave the tool out of its tools/list.
 */
export function scanParamHeaders(inputSchema: unknown): ScanResult {
  const params: ParamHeaderSpec[] = [];
  const problems: string[] = [];

  // 1. Walk only the statically reachable part: a chain of `properties` keys.
  const walk = (schema: unknown, path: string[]): void => {
    if (!isObject(schema) || !isObject(schema.properties)) return;
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!isObject(property)) continue;
      const here = [...path, key];
      if (MARKER in property) {
        const problem = checkMarker(property);
        if (problem) problems.push(`${here.join(".")}: ${problem}`);
        else
          params.push({
            name: String(property[MARKER]),
            path: here,
            type: primitiveType(property) as ParamType,
          });
      }
      walk(property, here);
    }
  };
  walk(inputSchema, []);

  // 2. Any marker that the walk above did not reach sits under items, a composition
  //    or conditional keyword, $defs or similar — which the spec forbids.
  const total = countMarkers(inputSchema);
  const reached = params.length + problems.length;
  if (total > reached) {
    problems.push(
      `${total - reached} marker(s) not statically reachable (only chains of "properties" are allowed; not items, oneOf/anyOf/allOf/not, if/then/else or $ref)`,
    );
  }

  // 3. Names must be unique, case-insensitively.
  const seen = new Map<string, string>();
  for (const param of params) {
    const lower = param.name.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined)
      problems.push(`"${param.name}" duplicates "${other}" (case-insensitive)`);
    seen.set(lower, param.name);
  }

  return problems.length > 0
    ? { ok: false, reason: problems.join("; ") }
    : { ok: true, params };
}

function checkMarker(property: JsonObject): string | undefined {
  const value = property[MARKER];
  if (typeof value !== "string") return "x-mcp-header must be a string";
  if (value.length === 0) return "x-mcp-header must not be empty";
  if (!TOKEN.test(value)) return `x-mcp-header "${value}" is not a valid HTTP token`;
  if (primitiveType(property) === undefined) {
    return "x-mcp-header is only allowed on string, integer or boolean properties (not number)";
  }
  return undefined;
}

/** The single primitive type of a property schema, allowing an extra "null". */
function primitiveType(property: JsonObject): ParamType | undefined {
  const declared = Array.isArray(property.type)
    ? property.type.filter((t) => t !== "null")
    : [property.type];
  if (declared.length !== 1) return undefined;
  const [type] = declared;
  return type === "string" || type === "integer" || type === "boolean"
    ? type
    : undefined;
}

function countMarkers(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((sum: number, item) => sum + countMarkers(item), 0);
  if (!isObject(value)) return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    // A marker's value is a string; a *property named* "x-mcp-header" has a schema object.
    if (key === MARKER && !isObject(child)) count += 1;
    else count += countMarkers(child);
  }
  return count;
}

/**
 * Header value for one argument, or undefined when the header must be omitted
 * (value absent or null, or of the wrong type for the marker).
 */
export function paramHeaderValue(
  spec: ParamHeaderSpec,
  args: unknown,
): string | undefined {
  let value: unknown = args;
  for (const key of spec.path) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  if (value === null || value === undefined) return undefined;
  switch (spec.type) {
    case "string":
      return typeof value === "string" ? encodeHeaderValue(value) : undefined;
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : undefined;
    case "boolean":
      return typeof value === "boolean" ? String(value) : undefined;
  }
}

// ── building and checking a request's headers ────────────────────────────────────

/**
 * Every metadata header a conforming client sends with this message (lowercase names).
 * Pass the called tool's definition to include its `Mcp-Param-*` headers.
 */
export function requestHeaders(
  message: unknown,
  tool?: Pick<Tool, "inputSchema">,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!isObject(message) || typeof message.method !== "string") return headers;
  const version = metaValue(message.params, "io.modelcontextprotocol/protocolVersion");
  if (typeof version === "string") headers[PROTOCOL_VERSION_HEADER] = version;
  if (!("id" in message)) return headers; // notification: header rules are undefined
  headers[METHOD_HEADER] = message.method;
  const source = NAME_SOURCES[message.method];
  const params = isObject(message.params) ? message.params : {};
  if (source !== undefined && typeof params[source] === "string") {
    headers[NAME_HEADER] = encodeHeaderValue(params[source]);
  }
  if (message.method === "tools/call" && tool) {
    const scan = scanParamHeaders(tool.inputSchema);
    if (scan.ok) {
      for (const spec of scan.params) {
        const value = paramHeaderValue(spec, params.arguments);
        if (value !== undefined)
          headers[`${PARAM_HEADER_PREFIX}${spec.name.toLowerCase()}`] = value;
      }
    }
  }
  return headers;
}

export type HeaderCheck = { ok: true } | { ok: false; reason: string };

/**
 * Server-side validation (§ Server Validation): every standard header present and equal
 * to the body, and every `Mcp-Param-*` the called tool declares matching its argument.
 * `headers` must use lowercase names (as Node delivers them). Failure → 400 + -32020.
 */
export function checkRequestHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  message: unknown,
  tool?: Pick<Tool, "inputSchema">,
): HeaderCheck {
  if (!isObject(message)) return { ok: false, reason: "request is not a JSON object" };
  const method = message.method;
  const params = isObject(message.params) ? message.params : {};

  const version = headers[PROTOCOL_VERSION_HEADER];
  if (version === undefined)
    return { ok: false, reason: "missing MCP-Protocol-Version header" };
  const bodyVersion = metaValue(params, "io.modelcontextprotocol/protocolVersion");
  if (version !== bodyVersion) {
    return {
      ok: false,
      reason: `MCP-Protocol-Version "${version}" does not match _meta "${String(bodyVersion)}"`,
    };
  }

  const methodHeader = headers[METHOD_HEADER];
  if (methodHeader === undefined)
    return { ok: false, reason: "missing Mcp-Method header" };
  if (methodHeader !== method) {
    return {
      ok: false,
      reason: `Mcp-Method "${methodHeader}" does not match body "${String(method)}"`,
    };
  }

  const source = typeof method === "string" ? NAME_SOURCES[method] : undefined;
  if (source !== undefined) {
    const nameHeader = headers[NAME_HEADER];
    if (nameHeader === undefined)
      return { ok: false, reason: "missing Mcp-Name header" };
    const decoded = decodeHeaderValue(nameHeader);
    if (!decoded.ok) return { ok: false, reason: `Mcp-Name: ${decoded.reason}` };
    if (decoded.value !== params[source]) {
      return {
        ok: false,
        reason: `Mcp-Name "${decoded.value}" does not match body ${source} "${String(params[source])}"`,
      };
    }
  }

  if (method === "tools/call" && tool) {
    const scan = scanParamHeaders(tool.inputSchema);
    if (scan.ok) {
      for (const spec of scan.params) {
        const problem = checkParamHeader(
          spec,
          headers[`${PARAM_HEADER_PREFIX}${spec.name.toLowerCase()}`],
          params.arguments,
        );
        if (problem) return { ok: false, reason: problem };
      }
    }
  }
  return { ok: true };
}

function checkParamHeader(
  spec: ParamHeaderSpec,
  header: string | undefined,
  args: unknown,
): string | undefined {
  const label = `Mcp-Param-${spec.name}`;
  let value: unknown = args;
  for (const key of spec.path) value = isObject(value) ? value[key] : undefined;
  const present = value !== null && value !== undefined;

  if (header === undefined)
    return present
      ? `missing ${label} header for argument ${spec.path.join(".")}`
      : undefined;
  if (!present)
    return `${label} header sent but argument ${spec.path.join(".")} is absent or null`;
  const decoded = decodeHeaderValue(header);
  if (!decoded.ok) return `${label}: ${decoded.reason}`;

  switch (spec.type) {
    case "integer": {
      // Compared numerically: "42.0" and 42 are equal (§ Server Validation note).
      const number = Number(decoded.value);
      return decoded.value.trim() !== "" && number === value
        ? undefined
        : `${label} "${decoded.value}" does not match ${String(value)}`;
    }
    case "boolean":
      return decoded.value === String(value)
        ? undefined
        : `${label} "${decoded.value}" does not match ${String(value)}`;
    case "string":
      return decoded.value === value
        ? undefined
        : `${label} "${decoded.value}" does not match body value`;
  }
}
