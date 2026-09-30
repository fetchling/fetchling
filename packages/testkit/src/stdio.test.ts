import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { Tool } from "@fetchling/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkStream } from "./checker.js";
import type { ServerFixture } from "./fixtures.js";
import { request } from "./meta.js";
import { type RawClient, rawClient } from "./raw-client.js";
import { serveStdio } from "./stdio-server.js";
import { type StdioFakeUpstream, startStdio } from "./stdio-transport.js";

const readFile: Tool = { name: "read_file", inputSchema: { type: "object" } };
const fs = (overrides: Partial<ServerFixture> = {}): ServerFixture => ({
  name: "fs",
  tools: [{ tool: readFile, behaviour: { kind: "echo" } }],
  ...overrides,
});

/** Drive serveStdio in-process through a pair of in-memory pipes. */
function harness(fixture: ServerFixture) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const waiters: {
    match(m: Record<string, unknown>): boolean;
    resolve(m: Record<string, unknown>): void;
  }[] = [];
  let exitCode: number | undefined;
  createInterface({ input: output }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    received.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const server = serveStdio({
    input,
    output,
    fixture,
    exit: (code) => (exitCode = code),
  });
  return {
    server,
    received,
    send: (message: unknown) =>
      input.write(
        `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
      ),
    close: () => input.end(),
    exitCode: () => exitCode,
    next(match: (m: Record<string, unknown>) => boolean) {
      const found = received.find(match);
      if (found) return Promise.resolve(found);
      return new Promise<Record<string, unknown>>((resolve) =>
        waiters.push({ match, resolve }),
      );
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("stdio server loop (in-process)", () => {
  it("answers one message per line", async () => {
    const h = harness(fs());
    const req = request("tools/list");
    h.send(req);
    expect(await h.next((m) => m.id === req.id)).toMatchObject({
      result: { resultType: "complete" },
    });
  });

  it("answers an unparseable line with a parse error that has no id", async () => {
    const h = harness(fs());
    h.send("{not json");
    expect(await h.next((m) => "error" in m)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Line is not valid JSON" },
    });
  });

  it("stops a request on notifications/cancelled and sends nothing for it", async () => {
    const h = harness(
      fs({
        tools: [
          {
            tool: readFile,
            behaviour: { kind: "delay", ms: 50, next: { kind: "echo" } },
          },
        ],
      }),
    );
    const req = request("tools/call", { name: "read_file" });
    h.send(req);
    h.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: req.id },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.received.filter((m) => m.id === req.id)).toEqual([]);
  });

  it("ignores cancellation of unknown requests", async () => {
    const h = harness(fs());
    h.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 999 },
    });
    const req = request("tools/list");
    h.send(req);
    expect(await h.next((m) => m.id === req.id)).toHaveProperty("result");
  });

  it("multiplexes subscriptions and ends them gracefully on stop", async () => {
    const h = harness(fs());
    const listen = request("subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    h.send(listen);
    await h.next((m) => m.method === "notifications/subscriptions/acknowledged");
    expect(
      h.server.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    ).toBe(1);
    expect(
      await h.next((m) => m.method === "notifications/tools/list_changed"),
    ).toMatchObject({
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": listen.id } },
    });

    h.server.stop();
    expect(await h.next((m) => m.id === listen.id)).toMatchObject({
      result: { resultType: "complete" },
    });
    expect(await h.next((m) => m.method === "notifications/cancelled")).toMatchObject({
      params: { requestId: listen.id },
    });
    expect(h.exitCode()).toBe(0);
  });

  it("exits when stdin closes (stdio.md § Shutdown)", async () => {
    const h = harness(fs());
    h.close();
    await settle();
    expect(h.exitCode()).toBe(0);
  });

  it("exits with the scripted code on a crash", async () => {
    const h = harness(
      fs({ tools: [{ tool: readFile, behaviour: { kind: "crash", exitCode: 3 } }] }),
    );
    h.send(request("tools/call", { name: "read_file" }));
    await settle();
    expect(h.exitCode()).toBe(3);
  });
});

describe("stdio fake in a child process", () => {
  let fake: StdioFakeUpstream | undefined;
  let client: RawClient | undefined;
  afterEach(async () => {
    await client?.close();
    await fake?.stop();
    client = undefined;
    fake = undefined;
  });

  it("serves a spawned client and reports its traffic back to the test", async () => {
    fake = await startStdio(fs());
    client = rawClient(fake);
    const exchange = await client.request("tools/list");
    expect(exchange.response).toMatchObject({
      result: { tools: [{ name: "read_file" }] },
    });
    const instance = await fake.waitForInstance({ nth: 1 });
    expect(instance.alive).toBe(true);
    await fake.traffic.waitFor({ direction: "out", instance: 1 });
    expect(fake.traffic.requests({ method: "tools/list" })).toHaveLength(1);
    expect(checkStream(fake.traffic.stream())).toEqual([]);
  });

  it("applies setBehaviour to the running process before resolving", async () => {
    fake = await startStdio(fs());
    client = rawClient(fake);
    await client.request("tools/list");
    await fake.setBehaviour(
      { tool: "read_file" },
      { kind: "toolError", message: "ENOENT" },
    );
    const exchange = await client.request("tools/call", { name: "read_file" });
    expect(exchange.response).toMatchObject({ result: { isError: true } });
  });

  it("setTools notifies toolsListChanged subscribers in the child", async () => {
    fake = await startStdio(fs());
    client = rawClient(fake);
    const subscription = await client.listen({ toolsListChanged: true });
    await subscription.acknowledged;
    await fake.setTools([
      { tool: { ...readFile, name: "write_file" }, behaviour: { kind: "echo" } },
    ]);
    expect(await subscription.next()).toMatchObject({
      method: "notifications/tools/list_changed",
    });
  });

  it("kill() crashes the process and in-flight requests fail instead of hanging", async () => {
    fake = await startStdio(
      fs({ tools: [{ tool: readFile, behaviour: { kind: "hang" } }] }),
    );
    client = rawClient(fake);
    await fake.waitForInstance({ nth: 1 });
    // Attach the expectation now: the request fails *during* kill(), and a rejection
    // with no handler yet is reported as unhandled even if one is attached later.
    const failed = expect(
      client.request("tools/call", { name: "read_file" }),
    ).rejects.toThrow(/exited/);
    await fake.traffic.waitFor({ method: "tools/call" });
    await fake.kill();
    await failed;
    expect(fake.instances()[0]?.alive).toBe(false);
    expect(fake.traffic.events("exit")).toHaveLength(1);
  });

  it("dieAfter crashes the process on the request after the limit", async () => {
    fake = await startStdio(fs({ faults: [{ kind: "dieAfter", requests: 1 }] }));
    client = rawClient(fake);
    expect((await client.request("tools/list")).response).toHaveProperty("result");
    await expect(client.request("tools/list")).rejects.toThrow(/exited/);
  });

  it("refuses fixtures with functions, which cannot reach a child process", async () => {
    await expect(
      startStdio(
        fs({
          tools: [
            {
              tool: readFile,
              behaviour: { kind: "custom", fn: () => ({ kind: "echo" }) },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/plain data/);
  });
});
