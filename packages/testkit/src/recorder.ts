import type { RequestId } from "@fetchling/protocol";
import type { StreamEntry } from "./checker.js";
import { isObject } from "./json.js";

/** One message as it crossed the wire, seen from the fake server. */
export interface Frame {
  /** Total order across everything this recorder saw. Diffs and assertions rely on it. */
  seq: number;
  /** Milliseconds since the recorder started. For humans; never assert on it. */
  at: number;
  /** "in" was received by the fake, "out" was sent by it. */
  direction: "in" | "out";
  /** Exactly the bytes of the message (one line on stdio, one body or SSE event on HTTP). */
  raw: string;
  /** The parsed message, or null if `raw` was not valid JSON. */
  message: unknown;
  /** HTTP: request headers on "in" frames, response headers on the first "out" frame of an exchange. Lowercase names. */
  headers?: Record<string, string>;
  /** HTTP: the response status, on the first "out" frame of an exchange. */
  status?: number;
  /** HTTP: which POST this frame belongs to. Frames of one request/response share it. */
  exchange?: number;
  /** stdio: which spawned process this frame belongs to (1, 2, … in spawn order). */
  instance?: number;
}

export type TrafficEventKind =
  | "spawn"
  | "exit"
  | "crash"
  | "restart"
  | "cancelled"
  | "rejected"
  | "subscription-open"
  | "subscription-closed"
  | "fixture-updated";

/** Something that happened besides a message: a process starting, a request cancelled… */
export interface TrafficEvent {
  seq: number;
  at: number;
  kind: TrafficEventKind;
  detail?: Record<string, unknown>;
  exchange?: number;
  instance?: number;
}

export interface FrameFilter {
  direction?: "in" | "out";
  /** Matches the message's `method` (requests and notifications). */
  method?: string;
  /** Matches the message's `id` (requests and responses). */
  id?: RequestId;
  instance?: number;
  exchange?: number;
}

export interface Traffic {
  /** Every frame, in order, optionally filtered. */
  frames(filter?: FrameFilter): Frame[];
  /** Requests the fake received (in-frames with a method and an id). */
  requests(filter?: Omit<FrameFilter, "direction">): Frame[];
  /** Notifications in either direction (frames with a method and no id). */
  notifications(filter?: FrameFilter): Frame[];
  count(filter?: FrameFilter): number;
  events(kind?: TrafficEventKind): TrafficEvent[];
  /** Resolves with the first matching frame, including one recorded before the call. */
  waitFor(filter: FrameFilter, options?: { timeoutMs?: number }): Promise<Frame>;
  /** Resolves with the first matching event, including one recorded before the call. */
  waitForEvent(
    kind: TrafficEventKind,
    options?: { timeoutMs?: number },
  ): Promise<TrafficEvent>;
  /** The frames as checker input: `checkStream(traffic.stream())`. */
  stream(filter?: FrameFilter): StreamEntry[];
  /** Forget everything recorded so far (sequence numbers keep increasing). */
  clear(): void;
}

export interface Recorder extends Traffic {
  frame(frame: Omit<Frame, "seq" | "at" | "message"> & { message?: unknown }): Frame;
  event(event: Omit<TrafficEvent, "seq" | "at">): TrafficEvent;
}

const DEFAULT_WAIT_MS = 2_000;

export function createRecorder(): Recorder {
  const started = performance.now();
  let seq = 0;
  let frames: Frame[] = [];
  let events: TrafficEvent[] = [];
  const frameWaiters = new Set<{ filter: FrameFilter; resolve(frame: Frame): void }>();
  const eventWaiters = new Set<{
    kind: TrafficEventKind;
    resolve(event: TrafficEvent): void;
  }>();

  const now = () => Math.round(performance.now() - started);

  function frame(
    input: Omit<Frame, "seq" | "at" | "message"> & { message?: unknown },
  ): Frame {
    seq += 1;
    const recorded: Frame = {
      ...input,
      seq,
      at: now(),
      message: "message" in input ? input.message : parse(input.raw),
    };
    frames.push(recorded);
    for (const waiter of frameWaiters) {
      if (matches(recorded, waiter.filter)) {
        frameWaiters.delete(waiter);
        waiter.resolve(recorded);
      }
    }
    return recorded;
  }

  function event(input: Omit<TrafficEvent, "seq" | "at">): TrafficEvent {
    seq += 1;
    const recorded: TrafficEvent = { ...input, seq, at: now() };
    events.push(recorded);
    for (const waiter of eventWaiters) {
      if (waiter.kind === recorded.kind) {
        eventWaiters.delete(waiter);
        waiter.resolve(recorded);
      }
    }
    return recorded;
  }

  function select(filter: FrameFilter = {}): Frame[] {
    return frames.filter((f) => matches(f, filter));
  }

  return {
    frame,
    event,
    frames: select,
    requests: (filter = {}) =>
      select({ ...filter, direction: "in" }).filter(
        (f) => isObject(f.message) && "id" in f.message && "method" in f.message,
      ),
    notifications: (filter = {}) =>
      select(filter).filter(
        (f) => isObject(f.message) && "method" in f.message && !("id" in f.message),
      ),
    count: (filter = {}) => select(filter).length,
    events: (kind) =>
      kind === undefined ? [...events] : events.filter((e) => e.kind === kind),
    waitFor(filter, options = {}) {
      const existing = frames.find((f) => matches(f, filter));
      if (existing) return Promise.resolve(existing);
      return withTimeout(
        new Promise<Frame>((resolve) => frameWaiters.add({ filter, resolve })),
        options.timeoutMs ?? DEFAULT_WAIT_MS,
        `no frame matching ${JSON.stringify(filter)}`,
      );
    },
    waitForEvent(kind, options = {}) {
      const existing = events.find((e) => e.kind === kind);
      if (existing) return Promise.resolve(existing);
      return withTimeout(
        new Promise<TrafficEvent>((resolve) => eventWaiters.add({ kind, resolve })),
        options.timeoutMs ?? DEFAULT_WAIT_MS,
        `no "${kind}" event`,
      );
    },
    stream: (filter = {}) =>
      select(filter).map((f) => ({ direction: f.direction, message: f.message })),
    clear() {
      frames = [];
      events = [];
    },
  };
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function matches(frame: Frame, filter: FrameFilter): boolean {
  if (filter.direction !== undefined && frame.direction !== filter.direction)
    return false;
  if (filter.instance !== undefined && frame.instance !== filter.instance) return false;
  if (filter.exchange !== undefined && frame.exchange !== filter.exchange) return false;
  const message = isObject(frame.message) ? frame.message : undefined;
  if (filter.method !== undefined && message?.method !== filter.method) return false;
  if (filter.id !== undefined && message?.id !== filter.id) return false;
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms: ${what}`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── diffing two conversations ────────────────────────────────────────────────────

/**
 * JSON Pointers (RFC 6901) that legitimately differ between two runs of the same
 * conversation — ids, client identity, trace context, server identity. `*` matches any
 * single segment. Note `~1` is how a `/` inside a key is written.
 */
export const DIFF_IGNORE_DEFAULTS: readonly string[] = [
  "/id",
  "/params/_meta/io.modelcontextprotocol~1clientInfo",
  "/params/_meta/traceparent",
  "/params/_meta/tracestate",
  "/params/_meta/baggage",
  "/result/_meta/io.modelcontextprotocol~1serverInfo",
  "/params/_meta/io.modelcontextprotocol~1subscriptionId",
  "/result/_meta/io.modelcontextprotocol~1subscriptionId",
];

export interface TrafficDifference {
  /** Position in the compared sequence (0-based). */
  index: number;
  /** JSON Pointer inside the message; "" means the whole message. */
  path: string;
  a: unknown;
  b: unknown;
}

export interface TrafficDiff {
  equal: boolean;
  differences: TrafficDifference[];
}

/**
 * Compare two recorded conversations message by message. Frames or plain messages are
 * accepted. This is Phase 1's regression test: fetchling in the middle must produce the
 * same upstream conversation as a direct connection, up to the ignored paths.
 */
export function diffTraffic(
  a: readonly (Frame | unknown)[],
  b: readonly (Frame | unknown)[],
  options: { ignore?: readonly string[] } = {},
): TrafficDiff {
  const ignore = (options.ignore ?? DIFF_IGNORE_DEFAULTS).map(parsePointer);
  const left = a.map(unwrap);
  const right = b.map(unwrap);
  const differences: TrafficDifference[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (index >= left.length || index >= right.length) {
      differences.push({ index, path: "", a: left[index], b: right[index] });
      continue;
    }
    compare(left[index], right[index], [], ignore, (path, x, y) =>
      differences.push({ index, path: toPointer(path), a: x, b: y }),
    );
  }
  return { equal: differences.length === 0, differences };
}

function unwrap(item: unknown): unknown {
  return isObject(item) && "seq" in item && "raw" in item && "message" in item
    ? item.message
    : item;
}

function compare(
  x: unknown,
  y: unknown,
  path: string[],
  ignore: readonly string[][],
  report: (path: string[], x: unknown, y: unknown) => void,
): void {
  if (ignore.some((pattern) => pointerMatches(pattern, path))) return;
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) {
      report(path, x, y);
      return;
    }
    for (const [i, item] of x.entries())
      compare(item, y[i], [...path, String(i)], ignore, report);
    return;
  }
  if (isObject(x) && isObject(y)) {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const key of [...keys].sort()) {
      const here = [...path, key];
      if (!(key in x) || !(key in y)) {
        if (!ignore.some((pattern) => pointerMatches(pattern, here)))
          report(here, x[key], y[key]);
        continue;
      }
      compare(x[key], y[key], here, ignore, report);
    }
    return;
  }
  if (!Object.is(x, y)) report(path, x, y);
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function toPointer(path: string[]): string {
  return path
    .map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
}

function pointerMatches(pattern: readonly string[], path: readonly string[]): boolean {
  return (
    pattern.length === path.length &&
    pattern.every((segment, i) => segment === "*" || segment === path[i])
  );
}
