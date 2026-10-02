import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  type JSONRPCNotification,
  PARSE_ERROR,
  type RequestId,
} from "@fetchling/protocol";
import type { Behaviour, ServerFixture } from "./fixtures.js";
import { createHandler, type Handler } from "./handler.js";
import { isObject } from "./json.js";
import { play } from "./player.js";
import type { TrafficEventKind } from "./recorder.js";
import { closingResponse, createSubscriptionRegistry } from "./subscriptions.js";

export interface StdioServerOptions {
  input: Readable;
  output: Writable;
  fixture: ServerFixture;
  /** Called when the fake must exit: a scripted crash, or stdin closing. */
  exit(code: number): void;
  /** Every message in or out, as raw text (for recording). */
  onFrame?(direction: "in" | "out", raw: string): void;
  onEvent?(kind: TrafficEventKind, detail?: Record<string, unknown>): void;
}

export interface StdioServer {
  /** Swap the fixture. `toolsChanged` notifies toolsListChanged subscribers, as setTools does over HTTP. */
  setFixture(fixture: ServerFixture, options?: { toolsChanged?: boolean }): void;
  emit(notification: JSONRPCNotification): number;
  /** Graceful shutdown: every subscription gets its final response and a cancellation, then exit(0). */
  stop(): void;
}

/**
 * The stdio transport (stdio.md, revision 2026-07-28) around a handler: one JSON-RPC
 * message per line in both directions, cancellation by `notifications/cancelled`,
 * subscriptions multiplexed on the one channel, exit when stdin closes.
 * Runs in-process with any streams, which is how its tests drive it; stdio-main.ts runs
 * it on the real process streams.
 */
export function serveStdio(options: StdioServerOptions): StdioServer {
  const { input, output } = options;
  const counters = new WeakMap<Behaviour, number>();
  let handler: Handler = createHandler(options.fixture, { counters });
  const inFlight = new Map<string, AbortController>();
  const subscriptions = createSubscriptionRegistry();
  let exiting = false;

  const writeLine = (text: string) => {
    if (exiting) return;
    options.onFrame?.("out", text);
    output.write(`${text}\n`);
  };

  const exit = (code: number) => {
    if (exiting) return;
    exiting = true;
    for (const controller of inFlight.values()) controller.abort();
    options.exit(code);
  };

  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  // A broken stdin is the client going away: the "close" handler below exits.
  lines.on("error", () => {});
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    options.onFrame?.("in", line);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: PARSE_ERROR, message: "Line is not valid JSON" },
        }),
      );
      return;
    }
    if (!isObject(message) || typeof message.method !== "string") return; // responses from a client are ignored
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled" && isObject(message.params)) {
        cancel(message.params.requestId);
      }
      return;
    }
    run(message, message.id);
  });
  // stdio.md § Shutdown: servers SHOULD exit promptly when stdin closes.
  lines.on("close", () => {
    options.onEvent?.("exit", { reason: "stdin closed" });
    exit(0);
  });

  function cancel(requestId: unknown): void {
    if (typeof requestId !== "string" && typeof requestId !== "number") return; // malformed: ignore
    const controller = inFlight.get(key(requestId));
    subscriptions.remove(requestId);
    if (!controller) return; // unknown or already finished: ignore (cancellation.md § Error Handling)
    controller.abort();
    inFlight.delete(key(requestId));
    options.onEvent?.("cancelled", { id: requestId });
  }

  function run(message: Record<string, unknown>, id: unknown): void {
    const steps = handler.handle(message);
    const controller = new AbortController();
    const requestKey =
      typeof id === "string" || typeof id === "number" ? key(id) : undefined;
    if (requestKey !== undefined) inFlight.set(requestKey, controller);
    const finish = () => {
      if (requestKey !== undefined && inFlight.get(requestKey) === controller)
        inFlight.delete(requestKey);
    };
    void play(
      steps,
      {
        send: (step) =>
          writeLine(step.kind === "send" ? JSON.stringify(step.message) : step.text),
        subscribe(step) {
          options.onEvent?.("subscription-open", {
            id: step.subscriptionId,
            filter: step.filter,
          });
          subscriptions.add({
            id: step.subscriptionId,
            filter: step.filter,
            deliver: (notification) => writeLine(JSON.stringify(notification)),
            end(graceful) {
              options.onEvent?.("subscription-closed", {
                id: step.subscriptionId,
                graceful,
              });
              finish();
              if (!graceful) return;
              // subscriptions.md § Graceful Closure: a final listen response. On stdio the
              // server also sends notifications/cancelled for the listen request
              // (cancellation.md: MUST, when it tears a subscription down).
              writeLine(JSON.stringify(closingResponse(step.subscriptionId)));
              writeLine(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/cancelled",
                  params: {
                    requestId: step.subscriptionId,
                    reason: "server shutting down",
                  },
                }),
              );
            },
          });
        },
        crash(exitCode) {
          options.onEvent?.("crash", { exitCode });
          exit(exitCode);
        },
        hold() {},
        done: finish,
      },
      controller.signal,
    );
  }

  return {
    setFixture(fixture, { toolsChanged = false } = {}) {
      const next = createHandler(fixture, { counters });
      handler = next;
      if (toolsChanged && next.capabilities.tools?.listChanged) {
        subscriptions.broadcast({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
      }
    },
    emit: (notification) => subscriptions.broadcast(notification),
    stop() {
      subscriptions.endAll(true);
      exit(0);
    },
  };
}

function key(id: RequestId): string {
  return `${typeof id}:${id}`;
}
