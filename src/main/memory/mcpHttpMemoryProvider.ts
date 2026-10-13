import { z } from "zod";
import {
  IntegrationError,
  type HttpTransportOptions,
} from "../integrations/httpTransport";
import { McpHttpTransport } from "../integrations/mcpHttpTransport";
import type {
  MemoryEntry,
  MemoryProvider,
  MemoryReadOptions,
  MemorySearchInput,
} from "./memoryProvider";

export interface MemoryToolMap {
  search?: string;
  get?: string;
}
export interface McpHttpMemoryProviderOptions extends HttpTransportOptions {
  tools: MemoryToolMap;
}
const entrySchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().max(1_000).optional(),
  content: z.string().min(1).max(64 * 1024),
}).strict();

export class McpHttpMemoryProvider implements MemoryProvider {
  private readonly transport: McpHttpTransport;
  private readonly tools: MemoryToolMap;
  constructor(options: McpHttpMemoryProviderOptions) {
    this.transport = new McpHttpTransport(options);
    this.tools = { ...options.tools };
    for (const name of Object.values(this.tools)) {
      if (typeof name !== "string" || !name.trim() || name.length > 256) {
        throw new IntegrationError("invalid_tool");
      }
    }
  }
  capabilities() {
    return { search: !!this.tools.search, get: !!this.tools.get };
  }
  async search(input: MemorySearchInput): Promise<readonly MemoryEntry[]> {
    if (!this.tools.search) return [];
    if (
      !input.projectId.trim() ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 || input.limit > 100
    ) {
      throw new IntegrationError("invalid_search");
    }
    const result = z.object({ entries: z.array(entrySchema).max(100) }).strict().safeParse(
      await this.transport.callTool(this.tools.search, {
        projectId: input.projectId,
        query: input.query,
        limit: input.limit,
      }, input.signal),
    );
    if (!result.success) {
      throw new IntegrationError("malformed_memory");
    }
    return result.data.entries.slice(0, input.limit);
  }
  async get(id: string, options: MemoryReadOptions): Promise<MemoryEntry | null> {
    if (!this.tools.get) return null;
    const result = z.object({ entry: entrySchema.nullable() }).strict().safeParse(
      await this.transport.callTool(this.tools.get, { id }, options.signal),
    );
    if (
      !result.success ||
      (result.data.entry !== null && result.data.entry.id !== id)
    ) {
      throw new IntegrationError("malformed_memory");
    }
    return result.data.entry;
  }
}
