import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ZoroDatabase } from "../../src/main/persistence/database";
import { TaskRepository } from "../../src/main/persistence/taskRepository";
import { ExportController, httpExportDestination, projectTaskOutcome, type MemoryExportDestination } from "../../src/main/memory/exportController";
import { OutboxRepository } from "../../src/main/memory/outboxRepository";
import type { TaskDetail } from "../../src/shared/ipc";

const databases: ZoroDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(file = ":memory:", cap = 100) {
  const database = openDatabase(file);
  databases.push(database);
  const tasks = new TaskRepository(database);
  const outbox = new OutboxRepository(database, undefined, cap);
  return { database, tasks, outbox };
}
function task(tasks: TaskRepository, id = "task-1"): TaskDetail {
  const project = { id: "project-1", name: "项目", canonicalPath: "private-project-path", lastOpenedAt: 1 };
  tasks.upsertProject(project);
  const snapshot: TaskDetail["task"] = {
    id, projectId: project.id, title: "private task text", prompt: "private prompt",
    status: "completed",
    providerSnapshot: {
      providerId: "provider-1", name: "模型", kind: "openai-compatible",
      baseUrl: "configured-endpoint", modelId: "model", contextLength: 1024,
    },
    routeDecision: { intent: "complex_code", lane: "premium", executionMode: "agentic", confidence: "high", reasonCode: "project-change" },
    selectionMode: "manual", executionMode: "agentic",
    progress: { percent: 100, elapsedSeconds: 1, remainingSeconds: 0, estimationState: "ready" },
    currentStepId: null, activeSince: null, pausedSince: null, pauseReason: null, createdAt: 1, updatedAt: 1,
  };
  tasks.create(snapshot);
  return { task: snapshot, project, steps: [], fileChanges: [], events: [], messages: [] };
}
function destination(id = "destination-1"): MemoryExportDestination {
  return { id, label: "导出目标", write: vi.fn(async ({ clientWriteId }) => ({ clientWriteId, id: "receipt" })) };
}
function consent(controller: ExportController, detail: TaskDetail, destinationId = "destination-1") {
  return controller.consent(controller.preview(detail, destinationId).token);
}

describe("consented memory exports", () => {
  it("migrates a version-three database without altering completed tasks", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-export-test-"));
    directories.push(directory);
    const file = join(directory, "test.sqlite");
    const { database, tasks } = setup(file);
    const detail = task(tasks);
    database.exec("DROP TABLE memory_export_outbox; UPDATE schema_version SET version = 3");
    database.close();
    const reopened = setup(file);
    expect(reopened.tasks.get(detail.task.id)).toEqual(detail.task);
    expect(reopened.database.prepare("SELECT version FROM schema_version").pluck().get()).toBe(4);
    expect(reopened.outbox.list()).toEqual([]);
  });

  it("does no write on completion, preview, missing consent or disabled configuration", async () => {
    const { tasks, outbox } = setup();
    const detail = task(tasks);
    const target = destination();
    const controller = new ExportController(outbox, [target]);
    controller.taskCompleted(detail);
    controller.preview(detail, target.id);
    expect(() => controller.consent("not-previewed")).toThrow("预览");
    await controller.flush();
    expect(target.write).not.toHaveBeenCalled();
    expect(outbox.list()).toEqual([]);
    const disabled = new ExportController(outbox);
    disabled.taskCompleted(detail);
    await disabled.restartFlush();
    expect(disabled.listDestinations()).toEqual([]);
    expect(() => disabled.preview(detail, target.id)).toThrow("未配置");
  });

  it("projects only structural outcomes even when every free-text field contains sensitive data", () => {
    const { tasks } = setup();
    const detail = task(tasks);
    const sensitive = ["api_key=private-credential", "private-file-contents", "private-tool-output", "private-transcript", String.fromCharCode(47) + "private" + String.fromCharCode(47) + "file", "C:" + String.fromCharCode(92) + "private-file"];
    const raw = sensitive.join("\n");
    detail.task.title = raw;
    detail.task.prompt = raw;
    detail.task.id = raw;
    detail.project.canonicalPath = raw;
    detail.steps = [{ id: raw, taskId: raw, order: 0, title: raw, completionCriteria: raw, status: "completed", estimateSeconds: 1, actualSeconds: 1, observedFraction: 1 }];
    detail.messages = [{ id: raw, role: "assistant", content: raw, createdAt: 1 }];
    detail.fileChanges = [{ id: raw, canonicalPath: raw, patch: raw, beforeHash: raw, afterHash: raw, createdAt: 1 }];
    detail.events = [{ id: raw, taskId: raw, at: 1, type: "tool_completed", payload: { callId: raw, name: "read_file", ok: true, content: raw, denied: false, data: {} } }];
    const entry = projectTaskOutcome(detail);
    for (const secret of sensitive) expect(JSON.stringify(entry)).not.toContain(secret);
    expect(entry.content).toContain("完成步骤：1");
    expect(entry.content).toContain("文件修改记录：1");
    expect(Object.keys(entry)).toEqual(["id", "title", "content"]);
    detail.task.status = "running";
    expect(() => projectTaskOutcome(detail)).toThrow("已完成");
  });

  it("binds consent to exact preview and destination, prevents duplicates and permits revocation before dispatch", async () => {
    const { tasks, outbox } = setup();
    const detail = task(tasks);
    const first = destination();
    const second = destination("destination-2");
    const controller = new ExportController(outbox, [first, second]);
    const preview = controller.preview(detail, first.id);
    const expected = structuredClone(preview.entry);
    preview.entry.content = "tampered";
    const record = controller.consent(preview.token);
    expect(outbox.list()[0].entry).toEqual(expected);
    expect(() => controller.consent(preview.token)).toThrow("预览");
    expect(consent(controller, detail).clientWriteId).toBe(record.clientWriteId);
    expect(controller.revoke(record.clientWriteId)).toBe(true);
    await controller.flush();
    expect(first.write).not.toHaveBeenCalled();
    consent(controller, detail);
    await Promise.all([controller.flush(), controller.flush()]);
    expect(first.write).toHaveBeenCalledTimes(1);
    expect(second.write).not.toHaveBeenCalled();
    expect(controller.list(detail.task.id)[0].state).toBe("acked");
    expect(controller.revoke(controller.list(detail.task.id)[0].clientWriteId)).toBe(false);
    consent(controller, detail);
    await controller.flush();
    expect(first.write).toHaveBeenCalledTimes(1);
  });

  it("limits an explicit task flush to that task's consented records", async () => {
    const { tasks, outbox } = setup();
    const first = task(tasks);
    const second = task(tasks, "task-2");
    const target = destination();
    const controller = new ExportController(outbox, [target]);
    const record = consent(controller, first);
    consent(controller, second);
    await controller.flush(first.task.id);
    expect(target.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clientWriteId: record.clientWriteId }));
    expect(controller.list(second.task.id)[0].state).toBe("queued");
  });

  it("serializes concurrent flushes for different tasks without dropping the later request", async () => {
    const { tasks, outbox } = setup();
    const first = task(tasks);
    const second = task(tasks, "task-2");
    let release!: () => void;
    const target = destination();
    let writes = 0;
    target.write = vi.fn(async ({ clientWriteId }) => {
      writes += 1;
      if (writes === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { clientWriteId, id: "receipt" };
    });
    const controller = new ExportController(outbox, [target]);
    consent(controller, first);
    consent(controller, second);
    const firstFlush = controller.flush(first.task.id);
    const secondFlush = controller.flush(second.task.id);
    await vi.waitFor(() => expect(target.write).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([firstFlush, secondFlush]);
    expect(target.write).toHaveBeenCalledTimes(2);
    expect(controller.list(first.task.id)[0].state).toBe("acked");
    expect(controller.list(second.task.id)[0].state).toBe("acked");
  });

  it("sends only consented projection and stable write identity through the optional HTTP adapter", async () => {
    const { tasks, outbox } = setup();
    const detail = task(tasks);
    const transport = vi.fn(async (_url, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      return Response.json({ client_write_id: body.client_write_id, id: "receipt" });
    });
    vi.stubGlobal("fetch", transport);
    const target = httpExportDestination("https://[::1]/export");
    const controller = new ExportController(outbox, [target]);
    controller.preview(detail, target.id);
    await controller.flush();
    expect(transport).not.toHaveBeenCalled();
    const record = consent(controller, detail, target.id);
    await controller.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    const options = transport.mock.calls[0][1];
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(options.body as string)).toEqual({
      client_write_id: record.clientWriteId, entry: projectTaskOutcome(detail),
    });
    expect(controller.list(detail.task.id)[0].state).toBe("acked");
  });

  it("persists unknown after an ambiguous timeout, including late acknowledgement and restart", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "memory-export-test-"));
    directories.push(directory);
    const file = join(directory, "test.sqlite");
    const { database, tasks, outbox } = setup(file);
    const detail = task(tasks);
    let acknowledge!: (value: { clientWriteId: string; id: string }) => void;
    const target = destination();
    target.write = vi.fn(() => new Promise<{ clientWriteId: string; id: string }>((resolve) => { acknowledge = resolve; }));
    const controller = new ExportController(outbox, [target], 10);
    const record = consent(controller, detail);
    const flushing = controller.flush();
    await vi.advanceTimersByTimeAsync(11);
    await flushing;
    expect(controller.list(detail.task.id)[0].state).toBe("unknown");
    acknowledge({ clientWriteId: record.clientWriteId, id: "receipt" });
    await Promise.resolve();
    expect(controller.list(detail.task.id)[0].state).toBe("unknown");
    database.close();
    const restarted = setup(file);
    const afterRestart = new ExportController(restarted.outbox, [target]);
    await afterRestart.restartFlush();
    expect(afterRestart.list(detail.task.id)[0]).toEqual({ ...record, state: "unknown" });
    expect(target.write).toHaveBeenCalledTimes(1);
  });

  it("flushes consented queued records after restart and marks interrupted sends unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-export-test-"));
    directories.push(directory);
    const file = join(directory, "test.sqlite");
    const { database, tasks, outbox } = setup(file);
    const first = task(tasks);
    const second = task(tasks, "task-2");
    const target = destination();
    const controller = new ExportController(outbox, [target]);
    const queued = consent(controller, first);
    const interrupted = consent(controller, second);
    outbox.transition(interrupted.clientWriteId, "queued", "sent");
    database.close();
    const restarted = setup(file);
    const afterRestart = new ExportController(restarted.outbox, [target]);
    await afterRestart.restartFlush();
    expect(afterRestart.list(first.task.id)[0]).toEqual({ ...queued, state: "acked" });
    expect(afterRestart.list(second.task.id)[0].state).toBe("unknown");
    expect(target.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clientWriteId: queued.clientWriteId }));
  });

  it("caps pending records including unknown writes without evicting consent or losing duplicates", async () => {
    const { tasks, outbox } = setup(":memory:", 1);
    const first = task(tasks);
    const second = task(tasks, "task-2");
    const target = destination();
    target.write = vi.fn(async () => { throw new Error("ambiguous"); });
    const controller = new ExportController(outbox, [target]);
    const record = consent(controller, first);
    expect(consent(controller, first).clientWriteId).toBe(record.clientWriteId);
    expect(() => consent(controller, second)).toThrow("已满");
    await controller.flush();
    expect(() => consent(controller, second)).toThrow("已满");
    expect(controller.list(first.task.id)[0].state).toBe("unknown");
  });

  it("leaves queues for unconfigured destinations untouched and rejects mismatched receipts", async () => {
    const { tasks, outbox } = setup();
    const detail = task(tasks);
    const target = destination();
    target.write = vi.fn(async () => ({ clientWriteId: "wrong", id: "receipt" }));
    const controller = new ExportController(outbox, [target]);
    consent(controller, detail);
    await new ExportController(outbox, [destination("different-destination")]).restartFlush();
    expect(controller.list(detail.task.id)[0].state).toBe("queued");
    await controller.flush();
    expect(controller.list(detail.task.id)[0].state).toBe("unknown");
  });
});
