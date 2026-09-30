import type { Tool } from "@fetchling/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkHttpExchange, checkResponse, checkStream } from "./checker.js";
import type { ServerFixture } from "./fixtures.js";
import { type HttpFakeUpstream, startHttp } from "./http-transport.js";
import { type RawClient, rawClient } from "./raw-client.js";

const readFile: Tool = {
  name: "read_file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};
const executeSql: Tool = {
  name: "execute_sql",
  inputSchema: {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      query: { type: "string" },
    },
  },
};
const fs = (overrides: Partial<ServerFixture> = {}): ServerFixture => ({
  name: "fs",
  tools: [
    { tool: readFile, behaviour: { kind: "echo" } },
    { tool: executeSql, behaviour: { kind: "echo" } },
  ],
  ...overrides,
});

let fake: HttpFakeUpstream | undefined;
let client: RawClient | undefined;
afterEach(async () => {
  await client?.close();
  await fake?.stop();
  client = undefined;
  fake = undefined;
});

async function start(
  fixture: ServerFixture,
): Promise<{ fake: HttpFakeUpstream; client: RawClient }> {
  fake = await startHttp(fixture);
  client = rawClient(fake);
  return { fake, client };
}

describe("Streamable HTTP fake", () => {
  it("answers a single response with a JSON body that passes every rule", async () => {
    const { fake, client } = await start(fs());
    const exchange = await client.request("tools/list", {}, { id: 1 });
    expect(exchange.status).toBe(200);
    expect(exchange.headers?.["content-type"]).toBe("application/json");
    expect(checkResponse({ id: 1, method: "tools/list" }, exchange.response)).toEqual(
      [],
    );

    const [request] = fake.traffic.requests();
    expect(
      checkHttpExchange({
        requestHeaders: request?.headers ?? {},
        request: request?.message,
        status: exchange.status ?? 0,
        responseHeaders: exchange.headers ?? {},
        messages: exchange.messages,
      }),
    ).toEqual([]);
  });

  it("streams progress over SSE and ends the stream after the response", async () => {
    const { client } = await start(
      fs({
        tools: [
          {
            tool: readFile,
            behaviour: {
              kind: "progress",
              steps: 3,
              intervalMs: 5,
              next: { kind: "echo" },
            },
          },
        ],
      }),
    );
    const exchange = await client.request(
      "tools/call",
      { name: "read_file" },
      { meta: { progressToken: "p1" } },
    );
    expect(exchange.headers?.["content-type"]).toBe("text/event-stream");
    expect(exchange.headers?.["x-accel-buffering"]).toBe("no");
    const methods = exchange.messages.map(
      (m) => (m as { method?: string }).method ?? "response",
    );
    expect(methods).toEqual([
      "notifications/progress",
      "notifications/progress",
      "notifications/progress",
      "response",
    ]);
  });

  it("maps errors to the transport's status codes", async () => {
    const { client } = await start(fs());
    expect(await client.request("nope/nothing")).toMatchObject({
      status: 404,
      response: { error: { code: -32601 } },
    });
    const unsupported = await client.request(
      "tools/list",
      {},
      { meta: { "io.modelcontextprotocol/protocolVersion": "2024-01-01" } },
    );
    expect(unsupported).toMatchObject({
      status: 400,
      response: { error: { code: -32022 } },
    });
    expect(await client.notify("notifications/whatever")).toMatchObject({
      status: 202,
      messages: [],
    });
  });

  it("allows only POST (405) and checks Origin (403)", async () => {
    const { fake, client } = await start(fs());
    expect((await fetch(fake.url)).status).toBe(405);
    const evil = await client.request(
      "tools/list",
      {},
      { headers: { origin: "https://evil.example" } },
    );
    expect(evil.status).toBe(403);
    const local = await client.request(
      "tools/list",
      {},
      { headers: { origin: "http://localhost:3000" } },
    );
    expect(local.status).toBe(200);
  });

  it("rejects headers that disagree with the body, before any work happens (-32020)", async () => {
    const { fake, client } = await start(fs());
    const exchange = await client.request(
      "tools/call",
      { name: "read_file" },
      { headers: { "mcp-name": "drop_table" } },
    );
    expect(exchange).toMatchObject({
      status: 400,
      response: { error: { code: -32020 } },
    });
    expect(fake.traffic.events("rejected")).toHaveLength(1);
  });

  it("requires Mcp-Param headers for x-mcp-header arguments", async () => {
    const { client } = await start(fs());
    const args = {
      name: "execute_sql",
      arguments: { region: "us-west1", query: "SELECT 1" },
    };
    expect((await client.request("tools/call", args)).status).toBe(400);
    expect(
      (await client.request("tools/call", args, { tool: executeSql })).status,
    ).toBe(200);
  });

  it("treats a closed stream as cancellation and sends nothing further", async () => {
    const { fake, client } = await start(
      fs({ tools: [{ tool: readFile, behaviour: { kind: "hang" } }] }),
    );
    const controller = new AbortController();
    // Expectation attached up front, so the rejection is never momentarily unhandled.
    const aborted = expect(
      client.request(
        "tools/call",
        { name: "read_file" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    await fake.traffic.waitFor({ method: "tools/call" });
    controller.abort();
    await aborted;
    await fake.traffic.waitForEvent("cancelled");
    expect(
      fake.traffic.frames({ direction: "out" }).filter((f) => f.raw !== ""),
    ).toHaveLength(0);
  });

  it("acknowledges subscriptions, delivers opted-in notifications, and closes gracefully", async () => {
    const { fake, client } = await start(fs());
    const subscription = await client.listen({
      toolsListChanged: true,
      promptsListChanged: true,
    });
    expect(await subscription.acknowledged).toMatchObject({
      params: { notifications: { toolsListChanged: true } },
    });

    await fake.setTools([{ tool: readFile, behaviour: { kind: "echo" } }]);
    expect(await subscription.next()).toMatchObject({
      method: "notifications/tools/list_changed",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscription.id } },
    });

    await fake.stop(); // afterEach stops it again: stop() is idempotent
    expect(await subscription.next()).toMatchObject({
      id: subscription.id,
      result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/subscriptionId": subscription.id },
      },
    });
  });

  it("kill() cuts the server off and restart() brings a fresh one back", async () => {
    const { fake, client } = await start(fs());
    await fake.kill();
    expect(fake.down).toBe(true);
    await expect(
      client.request("tools/list", {}, { timeoutMs: 1_000 }),
    ).rejects.toThrow();
    await fake.restart();
    expect((await client.request("tools/list")).status).toBe(200);
    expect(fake.traffic.events("restart")).toHaveLength(1);
  });

  it("a scripted crash takes the server down mid-request", async () => {
    const { fake, client } = await start(
      fs({ tools: [{ tool: readFile, behaviour: { kind: "crash" } }] }),
    );
    await expect(
      client.request("tools/call", { name: "read_file" }, { timeoutMs: 1_000 }),
    ).rejects.toThrow();
    expect(fake.down).toBe(true);
  });

  it("records a conversation that passes the stream rules", async () => {
    const { fake, client } = await start(fs());
    await client.request("server/discover");
    await client.request("tools/list");
    await client.request("tools/call", {
      name: "read_file",
      arguments: { path: "/x" },
    });
    expect(checkStream(fake.traffic.stream())).toEqual([]);
    expect(fake.traffic.requests()).toHaveLength(3);
  });
});
