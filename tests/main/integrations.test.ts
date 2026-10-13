import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpTransport, MAX_HTTP_RESPONSE_BYTES } from "../../src/main/integrations/httpTransport";
import { McpHttpTransport } from "../../src/main/integrations/mcpHttpTransport";
import { McpHttpMemoryProvider } from "../../src/main/memory/mcpHttpMemoryProvider";
import { approvalActionDigest, HttpReviewer } from "../../src/main/approval/httpReviewer";
import { runReviewerChain } from "../../src/main/approval/reviewerChain";
import { formatMemoryContext } from "../../src/main/memory/contextFormatter";
import type { ApprovalReviewContext } from "../../src/main/approval/types";

const servers: Server[] = [];
const signal = () => new AbortController().signal;
const context: ApprovalReviewContext = {
  decision: { level: "ask", summary: "运行命令", reasons: ["需要确认"], reasonCodes: ["not_allowlisted"] },
  operation: { kind: "shell", command: "echo test" }, tier: "T1",
};
async function server(handler: (body: Record<string, any>, response: ServerResponse, request: IncomingMessage) => void) {
  const http = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handler(JSON.parse(body), response, request));
  });
  servers.push(http);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("未启动测试服务");
  return { endpoint: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true };
}
function json(response: ServerResponse, body: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
function mcp(handler: (body: Record<string, any>, response: ServerResponse, request: IncomingMessage) => void) {
  return server((body, response, request) => {
    if (body.method === "initialize") {
      response.setHeader("Mcp-Session-Id", "test-session");
      json(response, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } });
    } else if (body.method === "notifications/initialized") {
      response.writeHead(204); response.end();
    } else handler(body, response, request);
  });
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((http) => new Promise<void>((resolve) => {
    http.closeAllConnections(); http.close(() => resolve());
  })));
});

describe("bounded HTTP transport", () => {
  it("is inert until invoked, requires HTTPS or an explicit numeric loopback, and bounds deadlines", () => {
    const resolveToken = vi.fn();
    new HttpTransport({ endpoint: "https://192.0.2.1/api", resolveToken, secretRef: "credential" });
    expect(resolveToken).not.toHaveBeenCalled();
    for (const endpoint of ["http://127.0.0.1", "http://192.0.2.1", "ftp://127.0.0.1", "https://user:pass@192.0.2.1", "https://192.0.2.1/?token=secret", "https://192.0.2.1/#secret", "invalid"]) {
      expect(() => new HttpTransport({ endpoint })).toThrow();
    }
    expect(() => new HttpTransport({ endpoint: "http://192.0.2.1", allowLoopbackHttp: true })).toThrow();
    expect(() => new HttpTransport({ endpoint: "http://[::1]", allowLoopbackHttp: true })).not.toThrow();
    for (const timeoutMs of [0, 14_999, 30_001, NaN, Infinity, 15_000.5]) {
      expect(() => new HttpTransport({ endpoint: "https://192.0.2.1", timeoutMs })).toThrow();
    }
    expect(() => new HttpTransport({ endpoint: "https://192.0.2.1", secretRef: "credential" })).toThrow();
  });
  it.each([401, 403])("rejects authentication status %s without echoing server text", async (status) => {
    const options = await server((_body, response) => { response.writeHead(status); response.end("private-response"); });
    await expect(new HttpTransport(options).post({}, signal())).rejects.toMatchObject({ code: "unauthorized", message: "集成请求失败：unauthorized。" });
  });
  it("rejects redirects without visiting their target", async () => {
    const target = vi.fn((_body, response: ServerResponse) => json(response, {}));
    const targetOptions = await server(target);
    const options = await server((_body, response) => { response.writeHead(307, { Location: targetOptions.endpoint }); response.end(); });
    await expect(new HttpTransport(options).post({}, signal())).rejects.toMatchObject({ code: "redirect_rejected" });
    expect(target).not.toHaveBeenCalled();
  });
  it.each([true, false])("caps advertised and streamed response bytes (length header: %s)", async (advertise) => {
    const options = await server((_body, response) => {
      response.writeHead(200, { "Content-Type": "application/json", ...(advertise ? { "Content-Length": MAX_HTTP_RESPONSE_BYTES + 1 } : {}) });
      response.write("x".repeat(MAX_HTTP_RESPONSE_BYTES)); response.end("x");
    });
    await expect(new HttpTransport(options).post({}, signal())).rejects.toMatchObject({ code: "response_too_large" });
  });
  it("accepts exactly 64 KB", async () => {
    const options = await server((_body, response) => {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify("x".repeat(MAX_HTTP_RESPONSE_BYTES - 2)));
    });
    expect((await new HttpTransport(options).post({}, signal())).body).toHaveLength(MAX_HTTP_RESPONSE_BYTES - 2);
  });
  it.each(["application/json", "text/event-stream", "text/html"])("rejects malformed or unsupported %s responses", async (type) => {
    const options = await server((_body, response) => { response.writeHead(200, { "Content-Type": type }); response.end("invalid"); });
    await expect(new HttpTransport(options).post({}, signal())).rejects.toMatchObject({ code: type === "application/json" ? "malformed_response" : type === "text/event-stream" ? "sse_unsupported" : "invalid_content_type" });
  });
  it("cancels an in-flight response and an already-aborted request", async () => {
    let received!: () => void;
    const ready = new Promise<void>((resolve) => { received = resolve; });
    const handler = vi.fn(() => received());
    const options = await server(handler);
    const controller = new AbortController();
    const result = new HttpTransport(options).post({}, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
    await ready; controller.abort(); await rejected;
    await expect(new HttpTransport(options).post({}, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("enforces the total deadline even while a server stalls after headers", async () => {
    let received!: () => void;
    const ready = new Promise<void>((resolve) => { received = resolve; });
    const options = await server((_body, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.flushHeaders(); received(); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = new HttpTransport({ ...options, timeoutMs: 15_000 }).post({}, signal());
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await ready; await vi.advanceTimersByTimeAsync(15_000); await rejected;
  });
  it("bounds and cancels token lookup without ever starting late I/O", async () => {
    const handler = vi.fn((_body, response: ServerResponse) => json(response, {}));
    const options = await server(handler);
    let finish!: (token: string) => void;
    const resolveToken = () => new Promise<string>((resolve) => { finish = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = new HttpTransport({ ...options, secretRef: "credential", resolveToken }).post({}, signal());
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    finish("test-only-token"); await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });
  it("cancels credential lookup and prevents late token completion from dispatching", async () => {
    const handler = vi.fn((_body, response: ServerResponse) => json(response, {}));
    const options = await server(handler);
    let finish!: (token: string) => void;
    const controller = new AbortController();
    const result = new HttpTransport({ ...options, secretRef: "credential",
      resolveToken: () => new Promise<string>((resolve) => { finish = resolve; }),
    }).post({}, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
    controller.abort(); await rejected;
    finish("test-only-token"); await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });
  it("sanitizes resolver failures, missing tokens and invalid header values", async () => {
    const handler = vi.fn((_body, response: ServerResponse) => json(response, {}));
    const options = await server(handler);
    for (const resolveToken of [() => { throw new Error("test-only-token"); }, () => undefined, () => "bad\nvalue"]) {
      await expect(new HttpTransport({ ...options, secretRef: "credential", resolveToken }).post({}, signal())).rejects.not.toThrow("test-only-token");
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("JSON HTTP MCP memory", () => {
  it("initializes a session, uses configured tools, scopes search and reads an entry", async () => {
    const calls: Record<string, any>[] = [];
    const options = await mcp((body, response, request) => {
      expect(request.headers["mcp-session-id"]).toBe("test-session");
      expect(request.headers["mcp-protocol-version"]).toBe("2025-03-26");
      calls.push(body);
      json(response, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(body.params.name === "find_records" ? { entries: [{ id: "record", content: "资料" }, { id: "other", content: "资料" }] } : { entry: { id: "record", content: "资料" } }) }] } });
    });
    const provider = new McpHttpMemoryProvider({ ...options, tools: { search: "find_records", get: "read_record" } });
    expect(provider.capabilities()).toEqual({ search: true, get: true });
    expect(await provider.search({ projectId: "project", query: "query", limit: 1, signal: signal() })).toEqual([{ id: "record", content: "资料" }]);
    expect(await provider.get("record", { signal: signal() })).toEqual({ id: "record", content: "资料" });
    expect(calls.map((call) => call.params)).toEqual([{ name: "find_records", arguments: { projectId: "project", query: "query", limit: 1 } }, { name: "read_record", arguments: { id: "record" } }]);
  });
  it("performs no I/O for unmapped capabilities", async () => {
    const handler = vi.fn(); const options = await server(handler);
    const provider = new McpHttpMemoryProvider({ ...options, tools: {} });
    expect(provider.capabilities()).toEqual({ search: false, get: false });
    expect(await provider.search({ projectId: "project", query: "", limit: 1, signal: signal() })).toEqual([]);
    expect(await provider.get("record", { signal: signal() })).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(["id", "rpc_error", "malformed", "isError", "non_json", "memory", "entry_id"])("rejects %s responses", async (failure) => {
    const options = await mcp((body, response) => json(response,
      failure === "malformed" ? {} : { jsonrpc: "2.0", id: failure === "id" ? "other" : body.id,
        ...(failure === "rpc_error" ? { error: { code: -1, message: "private" } } : { result: {
          isError: failure === "isError", content: [{ type: "text", text: failure === "non_json" ? "invalid" : JSON.stringify(failure === "entry_id" ? { entry: { id: "wrong", content: "text" } } : { entries: "wrong" }) }],
        } }),
      }));
    const provider = new McpHttpMemoryProvider({ ...options, tools: { search: "find", get: "read" } });
    await expect(failure === "entry_id" ? provider.get("record", { signal: signal() }) : provider.search({ projectId: "project", query: "", limit: 1, signal: signal() })).rejects.toThrow();
  });
  it("supports structured JSON results and a null get", async () => {
    const options = await mcp((body, response) => json(response, { jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { entry: null } } }));
    expect(await new McpHttpMemoryProvider({ ...options, tools: { get: "read" } }).get("record", { signal: signal() })).toBeNull();
  });
  it("rejects incompatible initialization and SSE", async () => {
    for (const sse of [false, true]) {
      const options = await server((body, response) => {
        if (sse) { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.end("data: {}\n\n"); }
        else json(response, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "invalid", capabilities: {} } });
      });
      await expect(new McpHttpTransport(options).callTool("find", {}, signal())).rejects.toThrow();
    }
  });
  it("bounds the entire MCP sequence rather than resetting the deadline at each request", async () => {
    let initialized!: () => void;
    const ready = new Promise<void>((resolve) => { initialized = resolve; });
    let toolCalled!: () => void;
    const toolReady = new Promise<void>((resolve) => { toolCalled = resolve; });
    const options = await server((body, response) => {
      if (body.method === "initialize") {
        setTimeout(() => json(response, { jsonrpc: "2.0", id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
        }), 10_000);
        initialized();
      } else if (body.method === "notifications/initialized") {
        response.writeHead(204); response.end();
      } else toolCalled();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = new McpHttpTransport({ ...options, timeoutMs: 15_000 }).callTool("find", {}, signal());
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await ready; await vi.advanceTimersByTimeAsync(10_000); await toolReady;
    await vi.advanceTimersByTimeAsync(5_000); await rejected;
  });
  it("cancels an active memory tool request without returning late records", async () => {
    const controller = new AbortController();
    const options = await mcp((_body) => controller.abort());
    const provider = new McpHttpMemoryProvider({ ...options, tools: { search: "find" } });
    await expect(provider.search({ projectId: "project", query: "", limit: 1,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
  });
  it("cancels during initialization and never calls tools afterward", async () => {
    const controller = new AbortController(); const methods: string[] = [];
    const options = await server((body) => { methods.push(body.method); controller.abort(); });
    await expect(new McpHttpTransport(options).callTool("find", {}, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(methods).toEqual(["initialize"]);
  });
});

describe("approval-review/v0", () => {
  it.each(["deny", "annotate", "request_information", "escalate"])("accepts a bound %s verdict through the reviewer interface", async (verdict) => {
    const options = await server((body, response) => {
      expect(body.context).toEqual(context);
      expect(body.action_digest).toBe(approvalActionDigest(context));
      json(response, { protocol: body.protocol, request_id: body.request_id, action_digest: body.action_digest, epoch: body.epoch, verdict, text: "请确认" });
    });
    const reviewer = new HttpReviewer({ ...options, name: "HTTP 审查", getEpoch: () => 3 });
    const result = await runReviewerChain(context, { reviewers: [reviewer] }, signal());
    expect(result?.review.entries[0]).toEqual({ reviewer: "HTTP 审查", verdict, text: "请确认" });
  });
  it.each(["request_id", "action_digest", "epoch", "protocol", "verdict", "text", "extra"])("rejects a mismatched or malformed %s", async (field) => {
    const options = await server((body, response) => {
      const result = { protocol: body.protocol, request_id: body.request_id, action_digest: body.action_digest, epoch: body.epoch, verdict: "annotate", text: "请确认", [field]: field === "epoch" ? 4 : field === "text" ? "" : "invalid" };
      json(response, result);
    });
    await expect(new HttpReviewer({ ...options, name: "HTTP 审查", getEpoch: () => 3 }).review(context, signal())).rejects.toThrow();
  });
  it("invalidates a correct verdict after an authority epoch changes", async () => {
    let epoch = 3;
    const options = await server((body, response) => { epoch++; json(response, { protocol: body.protocol, request_id: body.request_id, action_digest: body.action_digest, epoch: body.epoch, verdict: "annotate", text: "请确认" }); });
    await expect(new HttpReviewer({ ...options, name: "HTTP 审查", getEpoch: () => epoch }).review(context, signal())).rejects.toMatchObject({ code: "verdict_mismatch" });
  });
  it("propagates cancellation through the reviewer chain without publishing a late review", async () => {
    const controller = new AbortController();
    const options = await server(() => controller.abort());
    const result = await runReviewerChain(context, { reviewers: [
      new HttpReviewer({ ...options, name: "HTTP 审查", getEpoch: () => 1 }),
    ] }, controller.signal);
    expect(result).toBeNull();
  });
  it("canonicalizes object key order and binds the full action context", () => {
    expect(approvalActionDigest({ tier: context.tier, operation: context.operation, decision: context.decision })).toBe(approvalActionDigest(context));
    expect(approvalActionDigest({ ...context, operation: { kind: "shell", command: "changed" } })).not.toBe(approvalActionDigest(context));
    expect(approvalActionDigest({ ...context, tier: "T2" })).not.toBe(approvalActionDigest(context));
  });
  it("keeps tokens in headers and removes echoes from memory prompts, reviewer events and logs", async () => {
    const token = 'test-only-"secret-token';
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const requests: unknown[] = [];
    try {
      const options = await server((body, response, request) => {
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        requests.push(body);
        json(response, { protocol: body.protocol, request_id: body.request_id, action_digest: body.action_digest, epoch: body.epoch, verdict: "annotate", text: token });
      });
      const credentials = { secretRef: "credential", resolveToken: vi.fn(() => token) };
      const review = await runReviewerChain(context, { reviewers: [new HttpReviewer({ ...options, ...credentials, name: "HTTP 审查", getEpoch: () => 0 })] }, signal());
      const memoryOptions = await mcp((body, response) => json(response, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ entries: [{ id: "record", title: token, content: token }] }) }] } }));
      const entries = await new McpHttpMemoryProvider({ ...memoryOptions, ...credentials, tools: { search: "find" } }).search({ projectId: "project", query: "query", limit: 1, signal: signal() });
      expect(JSON.stringify(review)).not.toContain(token);
      expect(formatMemoryContext(entries).content).not.toContain(token);
      expect(JSON.stringify(entries)).not.toContain(token);
      expect(JSON.stringify(requests)).not.toContain(token);
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(token);
    } finally { logs.forEach((log) => log.mockRestore()); }
  });
});
