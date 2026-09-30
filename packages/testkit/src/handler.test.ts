import type { ElicitRequest, Tool } from "@fetchling/protocol";
import { describe, expect, it } from "vitest";
import { checkResponse } from "./checker.js";
import type { Behaviour, ServerFixture } from "./fixtures.js";
import { createHandler } from "./handler.js";
import { request } from "./meta.js";
import type { Step } from "./steps.js";

const readFile: Tool = {
  name: "read_file",
  description: "Read a file from disk",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function withTool(behaviour: Behaviour): ServerFixture {
  return { name: "fs", tools: [{ tool: readFile, behaviour }] };
}

/** What a step script puts on the wire, in order. */
function sent(steps: Step[]): unknown[] {
  return steps.flatMap((step) => {
    if (step.kind === "send") return [step.message];
    if (step.kind === "sendRaw") return [JSON.parse(step.text) as unknown];
    return [];
  });
}

/** The single message a script sends; fails the test ifthere isn't exactly one. */
function only(steps: Step[]): unknown {
  const messages = sent(steps);
  expect(messages).toHaveLength(1);
  return messages[0];
}

describe("protocol floor", () => {
  const handler = createHandler(withTool({ kind: "echo" }));

  it.each(["server/discover", "tools/list"])(
    "%s passes every checker rule",
    (method) => {
      const req = request(method);
      expect(checkResponse(req, only(handler.handle(req)))).toEqual([]);
    },
  );

  it("identifies itself in result _meta", () => {
    expect(only(handler.handle(request("tools/list")))).toMatchObject({
      result: { _meta: { "io.modelcontextprotocol/serverInfo": { name: "fs" } } },
    });
  });
});

describe("strict inbound checking", () => {
  const handler = createHandler(withTool({ kind: "echo" }));

  it("rejects a request without required _meta as -32602", () => {
    const steps = handler.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(only(steps)).toMatchObject({ id: 1, error: { code: -32602 } });
  });

  it("rejects an unsupported version as -32022 and says whatit supports", () => {
    const req = request(
      "tools/list",
      {},
      { "io.modelcontextprotocol/protocolVersion": "2024-01-01" },
    );
    expect(only(handler.handle(req))).toMatchObject({
      error: {
        code: -32022,
        data: { supported: ["2026-07-28"], requested: "2024-01-01" },
      },
    });
  });

  it("rejects a null id instead of answering it", () => {
    const steps = handler.handle({ jsonrpc: "2.0", id: null, method: "tools/list" });
    expect(only(steps)).toMatchObject({ error: { code: -32600 } });
  });

  it("answers an unknown tool with -32602", () => {
    const steps = handler.handle(request("tools/call", { name: "nope" }));
    expect(only(steps)).toMatchObject({ error: { code: -32602 } });
  });

  it("answers a method whose capability is not advertisedwith -32601", () => {
    expect(only(handler.handle(request("prompts/list")))).toMatchObject({
      error: { code: -32601 },
    });
  });
});

describe("tool errors versus protocol errors", () => {
  it("returns toolError as a result the model can see, not an error response", () => {
    const handler = createHandler(withTool({ kind: "toolError", message: "ENOENT" }));
    const response = only(handler.handle(request("tools/call", { name: "read_file" })));
    expect(response).toMatchObject({
      result: { resultType: "complete", isError: true },
    });
    expect(response).not.toHaveProperty("error");
  });
});

describe("multi round-trip requests", () => {
  const askPath: ElicitRequest = {
    method: "elicitation/create",
    params: {
      message: "Which file?",
      requestedSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  };
  const elicitation = {
    "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
  };

  it("round-trips the upstream's own requestState (the D4fixture)", () => {
    const handler = createHandler(
      withTool({
        kind: "inputRequired",
        inputRequests: { path: askPath },
        requestState: "upstream-own-state",
        next: { kind: "echo" },
      }),
    );
    const first = only(
      handler.handle(request("tools/call", { name: "read_file" }, elicitation)),
    );
    expect(first).toMatchObject({
      result: { resultType: "input_required", requestState: "upstream-own-state" },
    });

    const retry = request(
      "tools/call",
      {
        name: "read_file",
        requestState: "upstream-own-state",
        inputResponses: { path: { action: "accept", content: { path: "/etc/hosts" } } },
      },
      elicitation,
    );
    expect(only(handler.handle(retry))).toMatchObject({
      result: { resultType: "complete" },
    });
  });

  it("starts over when a retry loses the upstream's requestState", () => {
    // Exactly the bug fetchling would have if it replaced requestState instead of wrapping it.
    const handler = createHandler(
      withTool({
        kind: "inputRequired",
        requestState: "upstream-own-state",
        next: { kind: "echo" },
      }),
    );
    const retry = request("tools/call", {
      name: "read_file",
      requestState: "fetchling-envelope",
    });
    expect(only(handler.handle(retry))).toMatchObject({
      result: { resultType: "input_required" },
    });
  });

  it("refuses to elicit when the client did not declare elicitation (-32021)", () => {
    const handler = createHandler(
      withTool({
        kind: "inputRequired",
        inputRequests: { path: askPath },
        next: { kind: "echo" },
      }),
    );
    expect(
      only(handler.handle(request("tools/call", { name: "read_file" }))),
    ).toMatchObject({
      error: { code: -32021, data: { requiredCapabilities: { elicitation: {} } } },
    });
  });

  it("resumes a multi-stage flow at the deepest stage theretry satisfies", () => {
    const handler = createHandler(
      withTool({
        kind: "inputRequired",
        requestState: "stage-1",
        next: {
          kind: "inputRequired",
          requestState: "stage-2",
          next: { kind: "echo" },
        },
      }),
    );
    const call = (requestState?: string) =>
      only(
        handler.handle(
          request("tools/call", {
            name: "read_file",
            ...(requestState ? { requestState } : {}),
          }),
        ),
      );
    expect(call()).toMatchObject({ result: { requestState: "stage-1" } });
    expect(call("stage-1")).toMatchObject({ result: { requestState: "stage-2" } });
    expect(call("stage-2")).toMatchObject({ result: { resultType: "complete" } });
  });

  it("rejects an impossible fixture when it is created, not mid-test", () => {
    expect(() =>
      createHandler(withTool({ kind: "inputRequired", next: { kind: "echo" } })),
    ).toThrow(/inputRequests, requestState, or both/);
  });
});

describe("sequence", () => {
  it("fails the second call and recovers afterwards", () => {
    const handler = createHandler(
      withTool({
        kind: "sequence",
        steps: [
          { kind: "echo" },
          { kind: "protocolError", code: -31000, message: "flaky" },
        ],
        after: { kind: "echo" },
      }),
    );
    const call = () =>
      only(handler.handle(request("tools/call", { name: "read_file" })));
    expect(call()).toHaveProperty("result");
    expect(call()).toMatchObject({ error: { code: -31000 } });
    expect(call()).toHaveProperty("result");
  });
});

describe("subscriptions/listen", () => {
  it("acknowledges first, honouring only what the server advertises", () => {
    const handler = createHandler(withTool({ kind: "echo" }));
    const req = request("subscriptions/listen", {
      notifications: { toolsListChanged: true, promptsListChanged: true },
    });
    const steps = handler.handle(req);
    const ack = sent(steps)[0];
    expect(ack).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { toolsListChanged: true },
        _meta: { "io.modelcontextprotocol/subscriptionId": req.id },
      },
    });
    expect(ack).not.toHaveProperty("params.notifications.promptsListChanged");
    expect(steps.at(-1)).toEqual({ kind: "hang" });
  });
});

describe("pagination", () => {
  const tools = ["a", "b", "c", "d", "e"].map((name) => ({
    tool: { ...readFile, name },
    behaviour: { kind: "echo" } as const,
  }));
  const handler = createHandler({ name: "fs", tools, pageSize: 2 });

  it("pages through the whole list with opaque cursors", () => {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = only(
        handler.handle(request("tools/list", cursor === undefined ? {} : { cursor })),
      ) as {
        result: { tools: { name: string }[]; nextCursor?: string };
      };
      names.push(...response.result.tools.map((t) => t.name));
      cursor = response.result.nextCursor;
      if (cursor === undefined) break;
    }
    expect(names).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("answers an unreadable cursor with -32602 (pagination.md § Error Handling)", () => {
    expect(
      only(handler.handle(request("tools/list", { cursor: "garbage" }))),
    ).toMatchObject({ error: { code: -32602 } });
  });
});

describe("transport hints", () => {
  const handler = createHandler(withTool({ kind: "echo" }));

  it("marks method-not-found for HTTP 404 and missing _meta for HTTP 400", () => {
    expect(handler.handle(request("nope/nothing"))[0]).toMatchObject({
      kind: "send",
      httpStatus: 404,
    });
    expect(
      handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })[0],
    ).toMatchObject({ httpStatus: 400 });
  });

  it("tells the transport to register a subscription stream", () => {
    const req = request("subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    expect(handler.handle(req)).toContainEqual({
      kind: "subscribe",
      subscriptionId: req.id,
      filter: { toolsListChanged: true },
    });
  });

  it("continues sequence counters when a transport passes them to a new handler", () => {
    const behaviour: Behaviour = {
      kind: "sequence",
      steps: [{ kind: "echo" }, { kind: "toolError", message: "second" }],
    };
    const counters = new WeakMap<Behaviour, number>();
    const fixture = withTool(behaviour);
    only(
      createHandler(fixture, { counters }).handle(
        request("tools/call", { name: "read_file" }),
      ),
    );
    const second = only(
      createHandler(fixture, { counters }).handle(
        request("tools/call", { name: "read_file" }),
      ),
    );
    expect(second).toMatchObject({ result: { isError: true } });
  });
});
