import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONRPCNotification } from "@fetchling/protocol";
import {
  assertSerializable,
  type FakeUpstream,
  type McpServerEntry,
  type Target,
  withBehaviour,
  withFault,
  withTools,
} from "./fake.js";
import type { Behaviour, ServerFault, ServerFixture, ToolFixture } from "./fixtures.js";
import { createHandler } from "./handler.js";
import { createRecorder } from "./recorder.js";
import {
  type ControlConnection,
  type ControlServer,
  startControlServer,
} from "./stdio-control.js";

/** One spawned process of a stdio fake. */
export interface StdioInstance {
  /** 1, 2, … in the order processes connected back. Frames carry the same number. */
  readonly id: number;
  readonly pid: number;
  readonly alive: boolean;
}

export interface StdioFakeUpstream extends FakeUpstream {
  readonly transport: "stdio";
  /** What to spawn: `command` with `args`. Hand these to fetchling (or use mcpServerEntry()). */
  readonly command: string;
  readonly args: readonly string[];
  /** Every process spawned from this fake so far. */
  instances(): StdioInstance[];
  /** Resolves when the nth process (default: the next one not yet seen) has connected back. */
  waitForInstance(options?: {
    nth?: number;
    timeoutMs?: number;
  }): Promise<StdioInstance>;
  /** Kill every live process (default SIGKILL: an abrupt crash, as fetchling must survive). */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

const EXIT_WAIT_MS = 2_000;

/**
 * Prepare a fake stdio MCP server. Nothing runs yet: whoever executes `command` + `args`
 * starts a process. Each process reports its traffic back here, so `traffic` shows every
 * frame of every instance even though the test never touches their pipes.
 */
export async function startStdio(initial: ServerFixture): Promise<StdioFakeUpstream> {
  assertSerializable(initial);
  createHandler(initial); // validate now, not inside a child process

  const recorder = createRecorder();
  const directory = await mkdtemp(join(tmpdir(), "fetchling-testkit-"));
  const fixturePath = join(directory, `${safeFileName(initial.name)}.json`);
  let fixture = initial;
  await writeFile(fixturePath, JSON.stringify(fixture));

  const connections = new Map<number, ControlConnection>();
  const known = new Map<number, { id: number; pid: number; alive: boolean }>();
  const instanceWaiters: { nth: number; resolve(instance: StdioInstance): void }[] = [];
  const exitWaiters = new Map<number, (() => void)[]>();
  const fixtureAcks = new Map<number, (() => void)[]>();

  const control: ControlServer = await startControlServer({
    connected(connection) {
      connections.set(connection.instance, connection);
      const instance = { id: connection.instance, pid: connection.pid, alive: true };
      known.set(connection.instance, instance);
      recorder.event({
        kind: "spawn",
        instance: connection.instance,
        detail: { pid: connection.pid },
      });
      for (const waiter of [...instanceWaiters]) {
        if (waiter.nth === connection.instance) {
          instanceWaiters.splice(instanceWaiters.indexOf(waiter), 1);
          waiter.resolve(snapshot(instance));
        }
      }
    },
    report(connection, report) {
      if (report.t === "event" && report.kind === "fixture-updated") {
        for (const resolve of fixtureAcks.get(connection.instance) ?? []) resolve();
        fixtureAcks.delete(connection.instance);
      }
      if (report.t === "frame")
        recorder.frame({
          direction: report.d,
          raw: report.raw,
          instance: connection.instance,
        });
      else if (report.t === "event" && report.kind !== "exit") {
        recorder.event({
          kind: report.kind,
          instance: connection.instance,
          ...(report.detail ? { detail: report.detail } : {}),
        });
      }
    },
    disconnected(connection) {
      connections.delete(connection.instance);
      const instance = known.get(connection.instance);
      if (instance) instance.alive = false;
      recorder.event({ kind: "exit", instance: connection.instance });
      for (const resolve of exitWaiters.get(connection.instance) ?? []) resolve();
      for (const resolve of fixtureAcks.get(connection.instance) ?? []) resolve();
      fixtureAcks.delete(connection.instance);
      exitWaiters.delete(connection.instance);
    },
  });

  const command = process.execPath;
  const args = [stdioEntry(), "--fixture", fixturePath, "--control", control.address];

  async function update(next: ServerFixture, toolsChanged = false): Promise<void> {
    assertSerializable(next);
    createHandler(next); // validate before anything changes
    fixture = next;
    await writeFile(fixturePath, JSON.stringify(fixture)); // future spawns
    // Wait until every running process has swapped fixtures, so the next request sees the change.
    const acks = [...connections.values()].map(
      (connection) =>
        new Promise<void>((resolve) => {
          const list = fixtureAcks.get(connection.instance) ?? [];
          list.push(resolve);
          fixtureAcks.set(connection.instance, list);
          connection.send({ t: "fixture", fixture, toolsChanged });
        }),
    );
    await Promise.all(acks);
  }

  function waitForExit(instance: number): Promise<void> {
    if (!known.get(instance)?.alive) return Promise.resolve();
    return new Promise((resolve) => {
      const list = exitWaiters.get(instance) ?? [];
      list.push(resolve);
      exitWaiters.set(instance, list);
    });
  }

  async function waitForAllExits(timeoutMs: number): Promise<boolean> {
    const live = [...known.values()]
      .filter((i) => i.alive)
      .map((i) => waitForExit(i.id));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([Promise.all(live).then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  }

  const upstream: StdioFakeUpstream = {
    name: initial.name,
    transport: "stdio",
    command,
    args,
    traffic: recorder,
    fixture: () => fixture,
    instances: () => [...known.values()].map(snapshot),
    waitForInstance(options = {}) {
      const nth = options.nth ?? known.size + 1;
      const existing = known.get(nth);
      if (existing) return Promise.resolve(snapshot(existing));
      return new Promise((resolve, reject) => {
        const waiter = { nth, resolve };
        instanceWaiters.push(waiter);
        setTimeout(
          () => {
            const index = instanceWaiters.indexOf(waiter);
            if (index !== -1) {
              instanceWaiters.splice(index, 1);
              reject(
                new Error(
                  `Timed out waiting for stdio instance ${nth} of ${initial.name}`,
                ),
              );
            }
          },
          options.timeoutMs ?? EXIT_WAIT_MS * 5,
        );
      });
    },
    async setBehaviour(target: Target, behaviour: Behaviour) {
      await update(withBehaviour(fixture, target, behaviour));
    },
    async setTools(tools: ToolFixture[]) {
      await update(withTools(fixture, tools), true);
    },
    async inject(fault: ServerFault) {
      await update(withFault(fixture, fault));
    },
    async emit(notification: JSONRPCNotification) {
      for (const connection of connections.values())
        connection.send({ t: "emit", notification });
    },
    mcpServerEntry: (): McpServerEntry => ({ command, args: [...args] }),
    async kill(signal: NodeJS.Signals = "SIGKILL") {
      for (const instance of known.values()) {
        if (!instance.alive) continue;
        try {
          process.kill(instance.pid, signal);
        } catch {
          // already gone
        }
      }
      await waitForAllExits(EXIT_WAIT_MS);
    },
    async stop() {
      for (const connection of connections.values()) connection.send({ t: "stop" });
      if (!(await waitForAllExits(EXIT_WAIT_MS))) await upstream.kill("SIGKILL");
      await control.close();
      await rm(directory, { recursive: true, force: true });
    },
    async [Symbol.asyncDispose]() {
      await upstream.stop();
    },
  };
  return upstream;
}

function snapshot(instance: {
  id: number;
  pid: number;
  alive: boolean;
}): StdioInstance {
  return { id: instance.id, pid: instance.pid, alive: instance.alive };
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_") || "fixture";
}

/**
 * Where the child entry point lives. From the built package it sits next to this code
 * in dist/; when tests run against src/ it is the built copy in ../dist.
 */
function stdioEntry(): string {
  for (const candidate of ["./stdio-main.js", "../dist/stdio-main.js"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(
    "@fetchling/testkit: dist/stdio-main.js not found — run `pnpm build` first",
  );
}
