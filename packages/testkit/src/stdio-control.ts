/**
 * The side channel between a test process and the stdio fakes it started.
 *
 * On stdio, the process under test (fetchling) spawns the fake and owns its stdin and
 * stdout, so the test cannot watch those pipes. Instead each fake connects back to the
 * test over a local TCP socket, reports every frame and event, and accepts commands
 * (new fixture, emit a notification, stop). Newline-delimited JSON in both directions.
 */
import { once } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { JSONRPCNotification } from "@fetchling/protocol";
import type { ServerFixture } from "./fixtures.js";
import type { TrafficEventKind } from "./recorder.js";

/** Child → parent. */
export type ControlReport =
  | { t: "hello"; pid: number }
  | { t: "frame"; d: "in" | "out"; raw: string }
  | { t: "event"; kind: TrafficEventKind; detail?: Record<string, unknown> };

/** Parent → child. */
export type ControlCommand =
  | { t: "fixture"; fixture: ServerFixture; toolsChanged?: boolean }
  | { t: "emit"; notification: JSONRPCNotification }
  | { t: "stop" };

// ── parent side ─────────────────────────────────────────────────────────────────

export interface ControlConnection {
  readonly instance: number;
  readonly pid: number;
  send(command: ControlCommand): void;
}

export interface ControlServer {
  readonly address: string;
  close(): Promise<void>;
}

export async function startControlServer(handlers: {
  connected(connection: ControlConnection): void;
  report(connection: ControlConnection, report: ControlReport): void;
  disconnected(connection: ControlConnection): void;
}): Promise<ControlServer> {
  const sockets = new Set<Socket>();
  let instances = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let connection: ControlConnection | undefined;
    const lines = createInterface({
      input: socket,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    lines.on("line", (line) => {
      let report: ControlReport;
      try {
        report = JSON.parse(line) as ControlReport;
      } catch {
        return;
      }
      if (report.t === "hello" && connection === undefined) {
        instances += 1;
        const instance = instances;
        const pid = report.pid;
        connection = {
          instance,
          pid,
          send: (command) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(command)}\n`);
          },
        };
        handlers.connected(connection);
      }
      if (connection) handlers.report(connection, report);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (connection) handlers.disconnected(connection);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("control server has no TCP address");
  return {
    address: `127.0.0.1:${address.port}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

// ── child side ──────────────────────────────────────────────────────────────────

export interface ControlLink {
  report(report: ControlReport): void;
  onCommand(listener: (command: ControlCommand) => void): void;
  /** Resolves once everything reported so far has been handed to the OS. */
  flush(): Promise<void>;
}

/** Connect to the test process. Reports made before the connection opens are buffered. */
export function connectControl(address: string): ControlLink {
  const [host, port] = splitAddress(address);
  const socket = connect({ host, port });
  const listeners: ((command: ControlCommand) => void)[] = [];
  let failed = false;
  socket.on("error", () => {
    failed = true; // the test process went away: keep serving, just stop reporting
  });
  const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    try {
      const command = JSON.parse(line) as ControlCommand;
      for (const listener of listeners) listener(command);
    } catch {
      // ignore malformed commands
    }
  });
  return {
    report(report) {
      if (!failed) socket.write(`${JSON.stringify(report)}\n`);
    },
    onCommand(listener) {
      listeners.push(listener);
    },
    flush() {
      if (failed || socket.destroyed) return Promise.resolve();
      return new Promise((resolve) => socket.write("", () => resolve()));
    },
  };
}

function splitAddress(address: string): [string, number] {
  const colon = address.lastIndexOf(":");
  return [address.slice(0, colon), Number(address.slice(colon + 1))];
}
