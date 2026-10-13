import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HttpTransport,
  IntegrationError,
  type HttpTransportOptions,
} from "./httpTransport";

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}).strict();
const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).max(100),
});
const PROTOCOL_VERSION = "2025-03-26";

/** JSON-only MCP subset: initialize, notifications/initialized, tools/call. */
export class McpHttpTransport {
  private readonly http: HttpTransport;
  constructor(options: HttpTransportOptions) {
    this.http = new HttpTransport(options);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!name.trim() || name.length > 256) {
      throw new IntegrationError("invalid_tool");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, this.http.timeoutMs);
    try {
      let sessionId: string | undefined;
      const headers = () => ({
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      });
      const rpc = async (method: string, params: Record<string, unknown>) => {
        const id = randomUUID();
        const response = await this.http.post(
          { jsonrpc: "2.0", id, method, params },
          controller.signal,
          headers(),
        );
        const parsed = rpcSchema.safeParse(response.body);
        if (!parsed.success) {
          throw new IntegrationError("malformed_rpc");
        }
        if (parsed.data.id !== id) {
          throw new IntegrationError("rpc_id_mismatch");
        }
        if (parsed.data.error !== undefined) {
          throw new IntegrationError("rpc_error");
        }
        if (!Object.hasOwn(parsed.data, "result")) {
          throw new IntegrationError("malformed_rpc");
        }
        if (response.sessionId !== undefined) sessionId = response.sessionId;
        return parsed.data.result;
      };
      const initialized = await rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "memory-client", version: "1.0.0" },
      });
      const init = z.object({
        protocolVersion: z.literal(PROTOCOL_VERSION),
        capabilities: z.object({ tools: z.object({}).optional() }),
      }).safeParse(initialized);
      if (!init.success || !init.data.capabilities.tools) {
        throw new IntegrationError("unsupported_mcp");
      }
      await this.http.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        controller.signal,
        headers(),
        true,
      );
      const result = toolResultSchema.safeParse(await rpc("tools/call", { name, arguments: args }));
      if (controller.signal.aborted) {
        throw new IntegrationError("cancelled");
      }
      if (!result.success) {
        throw new IntegrationError("malformed_tool_result");
      }
      if (result.data.isError) {
        throw new IntegrationError("mcp_tool_error");
      }
      if (result.data.structuredContent !== undefined) return result.data.structuredContent;
      if (result.data.content.length !== 1) {
        throw new IntegrationError("malformed_tool_result");
      }
      try {
        return JSON.parse(result.data.content[0].text) as unknown;
      } catch {
        throw new IntegrationError("malformed_tool_result");
      }
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw new IntegrationError("timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}
