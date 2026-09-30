/**
 * Entry point of a stdio fake: `node stdio-main.js --fixture <file> [--control <host:port>]`.
 * Whoever spawns this (fetchling, a raw client, a test) talks MCP over stdin/stdout; the
 * optional control link reports traffic back to the test process (stdio-control.ts).
 * Built as its own file by tsdown; stdio-transport.ts finds it next to itself in dist/.
 */
import { readFileSync } from "node:fs";
import type { ServerFixture } from "./fixtures.js";
import { type ControlLink, connectControl } from "./stdio-control.js";
import { serveStdio } from "./stdio-server.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const fixturePath = argument("--fixture");
if (fixturePath === undefined) {
  process.stderr.write("testkit stdio fake: --fixture <file> is required\n");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ServerFixture;
const controlAddress = argument("--control");
const control: ControlLink | undefined = controlAddress
  ? connectControl(controlAddress)
  : undefined;
control?.report({ t: "hello", pid: process.pid });

const server = serveStdio({
  input: process.stdin,
  output: process.stdout,
  fixture,
  onFrame: (d, raw) => control?.report({ t: "frame", d, raw }),
  onEvent: (kind, detail) =>
    control?.report({ t: "event", kind, ...(detail ? { detail } : {}) }),
  exit(code) {
    // Let stdout and the control link drain first, so the messages written before a
    // scripted crash still arrive — then exit hard, as a crashing process would.
    void Promise.all([
      control?.flush(),
      new Promise((resolve) => process.stdout.write("", resolve)),
    ]).then(() => process.exit(code));
  },
});

control?.onCommand((command) => {
  switch (command.t) {
    case "fixture":
      server.setFixture(command.fixture, {
        toolsChanged: command.toolsChanged === true,
      });
      // The test side waits for this before setBehaviour/setTools resolve.
      control?.report({ t: "event", kind: "fixture-updated" });
      break;
    case "emit":
      server.emit(command.notification);
      break;
    case "stop":
      server.stop();
      break;
  }
});
