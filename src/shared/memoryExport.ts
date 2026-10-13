import { z } from "zod";
import type { MemoryEntry } from "../main/memory/memoryProvider";

export type MemoryExportState = "queued" | "sent" | "acked" | "unknown";
export interface MemoryExportView {
  clientWriteId: string;
  taskId: string;
  destinationId: string;
  state: MemoryExportState;
}
export interface MemoryExportPreview {
  token: string;
  destinationId: string;
  destinationLabel: string;
  entry: MemoryEntry;
}
export interface MemoryExportApi {
  destinations(): Promise<Array<{ id: string; label: string }>>;
  preview(taskId: string, destinationId: string): Promise<MemoryExportPreview>;
  consent(token: string): Promise<MemoryExportView>;
  list(taskId: string): Promise<MemoryExportView[]>;
  revoke(clientWriteId: string): Promise<boolean>;
  flush(taskId: string): Promise<void>;
}
const identifier = z.string().min(1).max(256);
export const exportPreviewRequestSchema = z.object({
  taskId: identifier, destinationId: identifier,
}).strict();
export const exportConsentRequestSchema = z.object({ token: identifier }).strict();
export const exportRevokeRequestSchema = z.object({ clientWriteId: identifier }).strict();
