import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDatabase,
  openDatabaseWithRecovery,
} from "../../src/main/persistence/database";
import { ProviderRepository } from "../../src/main/persistence/providerRepository";
import { TaskRepository } from "../../src/main/persistence/taskRepository";
import type {
  ProviderConfig,
  TaskSnapshot,
  TaskStep,
} from "../../src/shared/domain";

const openConnections: ReturnType<typeof openDatabase>[] = [];
const temporaryDirectories: string[] = [];

function database() {
  const db = openDatabase(":memory:");
  openConnections.push(db);
  return db;
}

function task(status: TaskSnapshot["status"] = "running"): TaskSnapshot {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "优化模型配置页面",
    prompt: "支持新增、编辑和删除模型 API",
    status,
    providerSnapshot: {
      providerId: "kimi",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
    },
    routeDecision: {
      intent: "complex_code",
      lane: "premium",
      executionMode: "agentic",
      confidence: "medium",
      reasonCode: "ambiguous-premium-default",
    },
    selectionMode: "manual",
    executionMode: "agentic",
    progress: {
      percent: 64,
      elapsedSeconds: 678,
      remainingSeconds: 402,
      estimationState: "ready",
    },
    currentStepId: "step-3",
    activeSince: 1_000,
    pausedSince: null,
    pauseReason: null,
    createdAt: 100,
    updatedAt: 1_000,
  };
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "provider-1",
    name: "团队模型",
    kind: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    modelId: "team-code",
    contextLength: 128_000,
    headers: { "X-Team": "zoro" },
    secretRef: "provider/provider-1",
    keySuffix: "1234",
    isDefault: false,
    connectionStatus: "untested",
    connectionMessage: null,
    lastTestedAt: null,
    billingNote: "计费规则由服务商决定",
    dashboardUrl: "",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    connection.close();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("task persistence", () => {
  it("creates schema version 4 on a fresh database", () => {
    const db = database();

    expect(
      db.prepare("SELECT version FROM schema_version").pluck().get(),
    ).toBe(4);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'model_routing_config', 'quick_chat_sessions', 'quick_chat_messages'
           )
           ORDER BY name`,
        )
        .pluck()
        .all(),
    ).toEqual([
      "model_routing_config",
      "quick_chat_messages",
      "quick_chat_sessions",
    ]);
  });

  it("rejects an existing empty schema version table before writing schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zorocoding-db-empty-version-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "zorocoding.sqlite");
    const incomplete = new Database(path);
    incomplete.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    incomplete.close();

    expect(() => openDatabase(path)).toThrow("Invalid ZoroCoding schema metadata");

    const inspected = new Database(path, { readonly: true });
    expect(
      inspected
        .prepare("SELECT COUNT(*) FROM schema_version")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
        )
        .get(),
    ).toBeUndefined();
    inspected.close();
  });

  it("rejects version zero when schema metadata already exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zorocoding-db-zero-version-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "zorocoding.sqlite");
    const incomplete = new Database(path);
    incomplete.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (0);
    `);
    incomplete.close();

    expect(() => openDatabase(path)).toThrow("Invalid ZoroCoding schema metadata");

    const inspected = new Database(path, { readonly: true });
    expect(
      inspected.prepare("SELECT version FROM schema_version").pluck().get(),
    ).toBe(0);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
        )
        .get(),
    ).toBeUndefined();
    inspected.close();
  });

  it("rejects ambiguous schema version rows before writing schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zorocoding-db-ambiguous-version-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "zorocoding.sqlite");
    const ambiguous = new Database(path);
    ambiguous.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (3);
      INSERT INTO schema_version(version) VALUES (999);
    `);
    ambiguous.close();

    expect(() => openDatabase(path)).toThrow("Invalid ZoroCoding schema metadata");

    const inspected = new Database(path, { readonly: true });
    expect(
      inspected
        .prepare("SELECT version FROM schema_version ORDER BY rowid")
        .pluck()
        .all(),
    ).toEqual([3, 999]);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
        )
        .get(),
    ).toBeUndefined();
    inspected.close();
  });

  it("migrates an existing version 2 task to version 4 routing defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zorocoding-db-v2-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "zorocoding.sqlite");
    const versionTwo = new Database(path);
    versionTwo.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (2);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        last_opened_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_snapshot_json TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        current_step_id TEXT,
        active_since INTEGER,
        paused_since INTEGER,
        pause_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects VALUES ('project-1', 'zoro-web-platform', '/tmp/zoro-web-platform', 100);
      INSERT INTO tasks VALUES (
        'task-v2', 'project-1', 'Existing task', 'Existing prompt', 'running',
        '{"providerId":"kimi","name":"KIMI K3","kind":"kimi","baseUrl":"https://api.moonshot.cn/v1","modelId":"kimi-k3","contextLength":1000000}',
        '{"percent":64,"elapsedSeconds":678,"remainingSeconds":402,"estimationState":"ready"}',
        'step-3', 1000, NULL, NULL, 100, 1000
      );
    `);
    versionTwo.close();

    const db = openDatabase(path);
    openConnections.push(db);
    const repository = new TaskRepository(db);

    expect(
      db.prepare("SELECT version FROM schema_version").pluck().get(),
    ).toBe(4);
    expect(repository.get("task-v2")).toMatchObject({
      selectionMode: "manual",
      executionMode: "agentic",
      routeDecision: {
        lane: "premium",
        executionMode: "agentic",
        reasonCode: "ambiguous-premium-default",
      },
    });

    db.close();
    openConnections.splice(openConnections.indexOf(db), 1);
    const reopened = openDatabase(path);
    openConnections.push(reopened);
    expect(new TaskRepository(reopened).get("task-v2")).toMatchObject({
      selectionMode: "manual",
      executionMode: "agentic",
      routeDecision: { lane: "premium" },
    });
  });

  it("cascades quick chat messages and restricts configured routing providers", () => {
    const db = database();
    const providers = new ProviderRepository(db);
    providers.create(provider());
    db.prepare(
      `INSERT INTO model_routing_config(id, light_provider_id, premium_provider_id, updated_at)
       VALUES (1, ?, NULL, ?)`,
    ).run("provider-1", 100);
    db.prepare(
      `INSERT INTO quick_chat_sessions(id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("session-1", "Quick question", 100, 100);
    db.prepare(
      `INSERT INTO quick_chat_messages(
        id, session_id, role, content, provider_snapshot_json,
        route_decision_json, status, error_message, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
    ).run("message-1", "session-1", "user", "Hello", "completed", 100);

    expect(() => providers.remove("provider-1")).toThrow();
    db.prepare("DELETE FROM quick_chat_sessions WHERE id = ?").run("session-1");
    expect(
      db
        .prepare("SELECT COUNT(*) FROM quick_chat_messages WHERE session_id = ?")
        .pluck()
        .get("session-1"),
    ).toBe(0);
  });

  it("backs up an unsupported database and reopens it read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zorocoding-db-recovery-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "zorocoding.sqlite");
    const future = new Database(path);
    future.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (999);
      CREATE TABLE future_data (value TEXT NOT NULL);
      INSERT INTO future_data(value) VALUES ('preserve me');
    `);
    future.close();

    const recovered = openDatabaseWithRecovery(path, () => 1234);
    openConnections.push(recovered.database);

    expect(recovered.readOnly).toBe(true);
    expect(recovered.backupPath).toContain(".backup-1234");
    await expect(access(recovered.backupPath!)).resolves.toBeUndefined();
    expect(
      recovered.database
        .prepare("SELECT value FROM future_data")
        .pluck()
        .get(),
    ).toBe("preserve me");
    expect(() =>
      recovered.database.exec("DELETE FROM future_data"),
    ).toThrow();
  });

  it("persists events and recovers running tasks as paused", () => {
    const db = database();
    const repository = new TaskRepository(db);
    repository.upsertProject({
      id: "project-1",
      name: "zoro-web-platform",
      canonicalPath: "/tmp/zoro-web-platform",
      lastOpenedAt: 100,
    });
    repository.create(task());

    repository.recoverInterrupted(5_000);

    expect(repository.get("task-1")?.status).toBe("paused");
    expect(repository.get("task-1")?.pauseReason).toBe("interrupted");
    expect(repository.events("task-1").at(-1)?.type).toBe("app_interrupted");
  });

  it("rolls back the snapshot when an event insert fails", () => {
    const db = database();
    const repository = new TaskRepository(db);
    repository.upsertProject({
      id: "project-1",
      name: "zoro-web-platform",
      canonicalPath: "/tmp/zoro-web-platform",
      lastOpenedAt: 100,
    });
    repository.create(task());
    const event = {
      id: "duplicate-event",
      taskId: "task-1",
      type: "app_interrupted" as const,
      at: 2_000,
      payload: {},
    };
    repository.appendEvent(event);

    expect(() => repository.appendEvent(event)).toThrow();
    expect(repository.get("task-1")?.updatedAt).toBe(2_000);
    expect(repository.events("task-1")).toHaveLength(1);
  });

  it("rejects corrupted JSON instead of returning a partial task", () => {
    const db = database();
    const repository = new TaskRepository(db);
    repository.upsertProject({
      id: "project-1",
      name: "zoro-web-platform",
      canonicalPath: "/tmp/zoro-web-platform",
      lastOpenedAt: 100,
    });
    repository.create(task());
    db.prepare("UPDATE tasks SET progress_json = ? WHERE id = ?").run(
      "{\"percent\":\"broken\"}",
      "task-1",
    );

    expect(() => repository.get("task-1")).toThrow();
  });

  it("replaces and returns steps in plan order", () => {
    const db = database();
    const repository = new TaskRepository(db);
    repository.upsertProject({
      id: "project-1",
      name: "zoro-web-platform",
      canonicalPath: "/tmp/zoro-web-platform",
      lastOpenedAt: 100,
    });
    repository.create(task());
    const steps: TaskStep[] = [
      {
        id: "step-2",
        taskId: "task-1",
        order: 2,
        title: "运行测试",
        completionCriteria: "测试通过",
        estimateSeconds: 60,
        actualSeconds: null,
        observedFraction: 0,
        status: "pending",
      },
      {
        id: "step-1",
        taskId: "task-1",
        order: 1,
        title: "修改代码",
        completionCriteria: "代码已更新",
        estimateSeconds: 120,
        actualSeconds: null,
        observedFraction: 0,
        status: "pending",
      },
    ];

    repository.replaceSteps("task-1", steps);

    expect(repository.steps("task-1").map((item) => item.id)).toEqual([
      "step-1",
      "step-2",
    ]);
  });
});

describe("provider persistence", () => {
  it("migrates schema version 1 provider health metadata through version 4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zorocoding-db-v1-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "zorocoding.sqlite");
    const versionOne = new Database(path);
    versionOne.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (1);
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model_id TEXT NOT NULL,
        context_length INTEGER NOT NULL,
        headers_json TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        key_suffix TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO providers VALUES (
        'provider-1', '团队模型', 'openai-compatible',
        'https://api.example.com/v1', 'team-code', 128000, '{}',
        'provider/provider-1/v1', '1234', 0, 100, 100
      );
    `);
    versionOne.close();

    const db = openDatabase(path);
    openConnections.push(db);
    const repository = new ProviderRepository(db);

    expect(
      db.prepare("SELECT version FROM schema_version").pluck().get(),
    ).toBe(4);
    expect(repository.get("provider-1")).toMatchObject({
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "计费规则由服务商决定",
      dashboardUrl: "",
    });
  });

  it("keeps exactly one default provider", () => {
    const repository = new ProviderRepository(database());
    repository.create(provider({ id: "provider-1" }));
    repository.create(provider({ id: "provider-2", name: "备用模型" }));

    repository.setDefault("provider-2", 500);

    expect(repository.get("provider-1")?.isDefault).toBe(false);
    expect(repository.get("provider-2")?.isDefault).toBe(true);
  });

  it("stores only a secret reference and masked suffix", () => {
    const db = database();
    const repository = new ProviderRepository(db);
    repository.create(provider());

    const raw = db
      .prepare("SELECT secret_ref, key_suffix FROM providers WHERE id = ?")
      .get("provider-1") as { secret_ref: string; key_suffix: string };

    expect(raw).toEqual({
      secret_ref: "provider/provider-1",
      key_suffix: "1234",
    });
    expect(JSON.stringify(raw)).not.toContain("api-key-value");
  });

  it("updates, lists, and removes provider metadata", () => {
    const repository = new ProviderRepository(database());
    repository.create(provider());

    repository.update("provider-1", {
      ...provider(),
      name: "更新后的团队模型",
      updatedAt: 900,
    });

    expect(repository.list().map((item) => item.name)).toEqual([
      "更新后的团队模型",
    ]);
    repository.remove("provider-1");
    expect(repository.get("provider-1")).toBeNull();
  });
});
