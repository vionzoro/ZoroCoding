import { randomUUID } from "node:crypto";
import type { ZoroDatabase } from "../persistence/database";
import { allowWrites, type LiveWriteGate } from "../persistence/liveWriteGate";
import type { MemoryEntry } from "./memoryProvider";
import type { MemoryExportView, MemoryExportState } from "../../shared/memoryExport";

export interface OutboxEntry extends MemoryExportView {
  entry: MemoryEntry;
}
interface OutboxRow {
  client_write_id: string;
  task_id: string;
  destination_id: string;
  state: MemoryExportState;
  entry_json: string;
}
function decode(row: OutboxRow): OutboxEntry {
  return {
    clientWriteId: row.client_write_id,
    taskId: row.task_id,
    destinationId: row.destination_id,
    state: row.state,
    entry: JSON.parse(row.entry_json) as MemoryEntry,
  };
}

export class OutboxRepository {
  constructor(
    private readonly database: ZoroDatabase,
    private readonly writeGate: LiveWriteGate = allowWrites,
    private readonly queueCap = 100,
  ) {
    if (!Number.isInteger(queueCap) || queueCap < 1) {
      throw new Error("导出队列上限无效。");
    }
  }

  enqueue(taskId: string, destinationId: string, entry: MemoryEntry): OutboxEntry {
    this.writeGate.assertWritable();
    return this.database.transaction(() => {
      const existing = this.database.prepare(
        "SELECT * FROM memory_export_outbox WHERE task_id = ? AND destination_id = ?",
      ).get(taskId, destinationId) as OutboxRow | undefined;
      if (existing) return decode(existing);
      const count = this.database.prepare(
        "SELECT COUNT(*) FROM memory_export_outbox WHERE state != 'acked'",
      ).pluck().get() as number;
      if (count >= this.queueCap) throw new Error("导出队列已满，请先处理待发送记录。");
      const clientWriteId = randomUUID();
      this.database.prepare(`INSERT INTO memory_export_outbox
        (client_write_id, task_id, destination_id, state, entry_json)
        VALUES (?, ?, ?, 'queued', ?)`).run(
        clientWriteId, taskId, destinationId, JSON.stringify(entry),
      );
      return { clientWriteId, taskId, destinationId, state: "queued" as const, entry };
    })();
  }

  list(taskId?: string): OutboxEntry[] {
    const rows = taskId === undefined
      ? this.database.prepare("SELECT * FROM memory_export_outbox ORDER BY rowid").all()
      : this.database.prepare("SELECT * FROM memory_export_outbox WHERE task_id = ? ORDER BY rowid").all(taskId);
    return (rows as OutboxRow[]).map(decode);
  }

  revoke(clientWriteId: string): boolean {
    this.writeGate.assertWritable();
    return this.database.prepare(
      "DELETE FROM memory_export_outbox WHERE client_write_id = ? AND state = 'queued'",
    ).run(clientWriteId).changes === 1;
  }

  transition(clientWriteId: string, from: MemoryExportState, to: MemoryExportState): boolean {
    this.writeGate.assertWritable();
    return this.database.prepare(
      "UPDATE memory_export_outbox SET state = ? WHERE client_write_id = ? AND state = ?",
    ).run(to, clientWriteId, from).changes === 1;
  }

  recoverInterrupted(): void {
    this.writeGate.assertWritable();
    // A process can die after the receiver accepted a write but before local acknowledgement.
    this.database.prepare("UPDATE memory_export_outbox SET state = 'unknown' WHERE state = 'sent'").run();
  }
}
