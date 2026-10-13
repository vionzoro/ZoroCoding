import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskDetail } from "../../shared/ipc";
import type { MemoryExportPreview, MemoryExportView } from "../../shared/memoryExport";
import type { MemoryEntry } from "./memoryProvider";
import type { OutboxRepository } from "./outboxRepository";

export interface MemoryExportDestination {
  /** Stable identity of the exact destination, including its configuration. */
  id: string;
  label: string;
  write(input: {
    entry: MemoryEntry;
    clientWriteId: string;
    signal: AbortSignal;
  }): Promise<{ clientWriteId: string; id: string }>;
}

/** Allowlisted structural outcome only. Free text may contain file contents or tool output. */
export function projectTaskOutcome(detail: Pick<TaskDetail, "task" | "steps" | "fileChanges">): MemoryEntry {
  if (detail.task.status !== "completed") throw new Error("仅可导出已完成任务。");
  return {
    id: createHash("sha256").update(detail.task.id).digest("hex"),
    title: "任务完成记录",
    content: `任务已完成。完成步骤：${detail.steps.filter((step) => step.status === "completed").length}；跳过步骤：${detail.steps.filter((step) => step.status === "skipped").length}；文件修改记录：${detail.fileChanges.length}。`,
  };
}

function view(entry: MemoryExportView): MemoryExportView {
  return {
    clientWriteId: entry.clientWriteId, taskId: entry.taskId,
    destinationId: entry.destinationId, state: entry.state,
  };
}

export class ExportController {
  private readonly previews = new Map<string, { taskId: string; preview: MemoryExportPreview }>();
  private readonly candidates = new Map<string, MemoryEntry>();
  private dispatchQueue: Promise<void> = Promise.resolve();
  private readonly flushes = new Map<string, Promise<void>>();

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly destinations: readonly MemoryExportDestination[] = [],
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("导出超时设置无效。");
    }
    if (new Set(destinations.map((destination) => destination.id)).size !== destinations.length) {
      throw new Error("导出目标不可重复。");
    }
  }

  listDestinations(): Array<{ id: string; label: string }> {
    return this.destinations.map(({ id, label }) => ({ id, label }));
  }

  taskCompleted(detail: Pick<TaskDetail, "task" | "steps" | "fileChanges">): void {
    if (this.destinations.length === 0) return;
    if (this.candidates.size >= 100) this.candidates.delete(this.candidates.keys().next().value!);
    this.candidates.set(detail.task.id, projectTaskOutcome(detail));
  }

  preview(detail: Pick<TaskDetail, "task" | "steps" | "fileChanges">, destinationId: string): MemoryExportPreview {
    if (detail.task.status !== "completed") throw new Error("仅可导出已完成任务。");
    const destination = this.destinations.find((item) => item.id === destinationId);
    if (!destination) throw new Error("导出目标未配置。");
    // Reconstruct after restart; never accept renderer-supplied content.
    const entry = this.candidates.get(detail.task.id) ?? projectTaskOutcome(detail);
    const preview = { token: randomUUID(), destinationId, destinationLabel: destination.label, entry };
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.token, { taskId: detail.task.id, preview });
    return structuredClone(preview);
  }

  consent(token: string): MemoryExportView {
    const candidate = this.previews.get(token);
    if (!candidate) throw new Error("请先预览导出内容。");
    const { taskId, preview } = candidate;
    const entry = this.outbox.enqueue(taskId, preview.destinationId, preview.entry);
    this.previews.delete(token);
    return view(entry);
  }

  list(taskId: string): MemoryExportView[] { return this.outbox.list(taskId).map(view); }
  revoke(clientWriteId: string): boolean { return this.outbox.revoke(clientWriteId); }

  async restartFlush(): Promise<void> {
    if (this.destinations.length === 0) return;
    this.outbox.recoverInterrupted();
    await this.flush();
  }

  flush(taskId?: string): Promise<void> {
    const key = taskId ?? "*";
    const pending = this.flushes.get(key);
    if (pending) return pending;
    const flushing = this.dispatchQueue.then(() => this.dispatchQueued(taskId))
      .finally(() => { this.flushes.delete(key); });
    this.flushes.set(key, flushing);
    this.dispatchQueue = flushing.catch(() => {});
    return flushing;
  }

  private async dispatchQueued(taskId?: string): Promise<void> {
    for (const item of this.outbox.list(taskId)) {
      if (item.state !== "queued") continue;
      const destination = this.destinations.find((candidate) => candidate.id === item.destinationId);
      if (!destination) continue;
      // Persist before I/O. The conditional transition also respects revocation while flushing.
      if (!this.outbox.transition(item.clientWriteId, "queued", "sent")) continue;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("导出确认超时。"));
          }, this.timeoutMs);
        });
        const result = await Promise.race([
          Promise.resolve().then(() => destination.write({
            entry: item.entry, clientWriteId: item.clientWriteId, signal: controller.signal,
          })), deadline,
        ]);
        if (result.clientWriteId !== item.clientWriteId || !result.id) {
          throw new Error("导出确认无效。");
        }
        this.outbox.transition(item.clientWriteId, "sent", "acked");
      } catch {
        this.outbox.transition(item.clientWriteId, "sent", "unknown");
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** Optional HTTP adapter: no request is made until a preview has been consented. */
export function httpExportDestination(endpoint: string): MemoryExportDestination {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("导出端点必须使用 HTTPS，且不包含凭证、查询参数或片段。");
  }
  const responseSchema = z.object({ client_write_id: z.string().min(1), id: z.string().min(1) });
  return {
    id: createHash("sha256").update(url.href).digest("hex"),
    label: url.href,
    async write({ entry, clientWriteId, signal }) {
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_write_id: clientWriteId, entry }),
      });
      if (!response.ok) throw new Error("导出未获得确认。");
      const result = responseSchema.parse(await response.json());
      return { clientWriteId: result.client_write_id, id: result.id };
    },
  };
}
