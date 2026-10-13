import type {
  MemoryEntry,
  MemoryProvider,
  MemoryReadOptions,
  MemorySearchInput,
} from "./memoryProvider";

export class NoopMemoryProvider implements MemoryProvider {
  capabilities() {
    return { search: false, get: false };
  }

  async search(_input: MemorySearchInput): Promise<readonly MemoryEntry[]> {
    return [];
  }

  async get(_id: string, _options: MemoryReadOptions): Promise<MemoryEntry | null> {
    return null;
  }
}
