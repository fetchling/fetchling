import { setTimeout as sleep } from "node:timers/promises";
import type { RawStep, SendStep, Step, SubscribeStep } from "./steps.js";

/**
 * What a transport does with each step. The player owns timing and cancellation; the
 * sink owns framing (a JSON body, an SSE event, a line on stdout).
 */
export interface PlaySink {
  send(step: SendStep | RawStep): void;
  subscribe(step: SubscribeStep): void;
  /** The process "dies": the transport drops everything, as a real crash would. */
  crash(exitCode: number): void;
  /** The script ended without finishing the request: keep it open until cancelled. */
  hold(): void;
  /** The script is complete: the transport can end this request's response. */
  done(): void;
}

/**
 * Play a handler's script. Stops quietly when `signal` aborts — that is how cancellation
 * works on both transports, and a cancelled request must not produce any more output.
 */
export async function play(
  steps: readonly Step[],
  sink: PlaySink,
  signal: AbortSignal,
): Promise<void> {
  for (const step of steps) {
    if (signal.aborted) return;
    switch (step.kind) {
      case "wait":
        try {
          await sleep(step.ms, undefined, { signal });
        } catch {
          return; // aborted while waiting
        }
        break;
      case "send":
      case "sendRaw":
        sink.send(step);
        break;
      case "subscribe":
        sink.subscribe(step);
        break;
      case "crash":
        sink.crash(step.exitCode);
        return;
      case "hang":
        sink.hold();
        return;
    }
  }
  if (!signal.aborted) sink.done();
}

/** Whether a script is a single immediate-or-delayed response: the only shape a JSON body can carry. */
export function isSingleResponse(steps: readonly Step[]): boolean {
  let sends = 0;
  for (const step of steps) {
    if (step.kind === "send" || step.kind === "sendRaw") sends += 1;
    else if (step.kind !== "wait") return false;
  }
  return sends === 1;
}
