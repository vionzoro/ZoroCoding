export interface MemoryEntry {
  id: string;
  title?: string;
  content: string;
}

export interface MemoryReadOptions {
  signal: AbortSignal;
}

export interface MemorySearchInput extends MemoryReadOptions {
  projectId: string;
  query: string;
  limit: number;
}

/** Read-only port. Providers must respect project scope and cancellation. */
export interface MemoryProvider {
  capabilities(): { search: boolean; get: boolean };
  search(input: MemorySearchInput): Promise<readonly MemoryEntry[]>;
  get(id: string, options: MemoryReadOptions): Promise<MemoryEntry | null>;
}
