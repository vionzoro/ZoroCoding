import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
} from "node:fs";

export type ZoroDatabase = Database.Database;

const SCHEMA_VERSION = 5;

function columnExists(
  database: ZoroDatabase,
  table: string,
  column: string,
): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

function addColumnIfMissing(
  database: ZoroDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  if (!columnExists(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function createBaseTables(database: ZoroDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      canonical_path TEXT NOT NULL UNIQUE,
      last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_snapshot_json TEXT NOT NULL,
      route_decision_json TEXT NOT NULL DEFAULT '{"intent":"complex_code","lane":"premium","executionMode":"agentic","confidence":"medium","reasonCode":"ambiguous-premium-default"}',
      selection_mode TEXT NOT NULL DEFAULT 'manual',
      execution_mode TEXT NOT NULL DEFAULT 'agentic',
      progress_json TEXT NOT NULL,
      current_step_id TEXT,
      active_since INTEGER,
      paused_since INTEGER,
      pause_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_events_task_time
      ON task_events(task_id, at);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      canonical_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      patch TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
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
      connection_status TEXT NOT NULL DEFAULT 'untested',
      connection_message TEXT,
      last_tested_at INTEGER,
      billing_note TEXT NOT NULL DEFAULT '计费规则由服务商决定',
      dashboard_url TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS providers_single_default
      ON providers(is_default)
      WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS model_routing_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      light_provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
      premium_provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quick_chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quick_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES quick_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      provider_snapshot_json TEXT,
      route_decision_json TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function migrateV1ToV2(database: ZoroDatabase): void {
  addColumnIfMissing(
    database,
    "providers",
    "connection_status",
    "connection_status TEXT NOT NULL DEFAULT 'untested'",
  );
  addColumnIfMissing(database, "providers", "connection_message", "connection_message TEXT");
  addColumnIfMissing(database, "providers", "last_tested_at", "last_tested_at INTEGER");
  addColumnIfMissing(
    database,
    "providers",
    "billing_note",
    "billing_note TEXT NOT NULL DEFAULT '计费规则由服务商决定'",
  );
  addColumnIfMissing(
    database,
    "providers",
    "dashboard_url",
    "dashboard_url TEXT NOT NULL DEFAULT ''",
  );
  database.prepare("UPDATE schema_version SET version = 2").run();
}

function migrateV2ToV3(database: ZoroDatabase): void {
  addColumnIfMissing(
    database,
    "tasks",
    "route_decision_json",
    "route_decision_json TEXT NOT NULL DEFAULT '{\"intent\":\"complex_code\",\"lane\":\"premium\",\"executionMode\":\"agentic\",\"confidence\":\"medium\",\"reasonCode\":\"ambiguous-premium-default\"}'",
  );
  addColumnIfMissing(
    database,
    "tasks",
    "selection_mode",
    "selection_mode TEXT NOT NULL DEFAULT 'manual'",
  );
  addColumnIfMissing(
    database,
    "tasks",
    "execution_mode",
    "execution_mode TEXT NOT NULL DEFAULT 'agentic'",
  );
  database.prepare("UPDATE schema_version SET version = 3").run();
}

function migrateV3ToV4(database: ZoroDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS integration_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      endpoint TEXT NOT NULL DEFAULT '',
      secret_ref TEXT,
      key_suffix TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);
  database.prepare("UPDATE schema_version SET version = 4").run();
}

function migrateV4ToV5(database: ZoroDatabase): void {
  addColumnIfMissing(
    database,
    "integration_settings",
    "options_json",
    "options_json TEXT NOT NULL DEFAULT '{}'",
  );
  database.prepare("UPDATE schema_version SET version = 5").run();
}

function migrate(database: ZoroDatabase): void {
  const hasVersionTable =
    database
      .prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'schema_version'`,
      )
      .get() !== undefined;
  let version: number;
  if (!hasVersionTable) {
    const hasUserSchema =
      database
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .get() !== undefined;
    if (hasUserSchema) {
      throw new Error(
        "Invalid ZoroCoding schema metadata: version table is missing",
      );
    }
    version = 0;
  } else {
    const versions = database
      .prepare("SELECT version FROM schema_version")
      .all() as Array<{ version: number }>;
    if (versions.length !== 1) {
      throw new Error(
        "Invalid ZoroCoding schema metadata: expected one version row",
      );
    }
    version = versions[0].version;
  }
  if (version === 0 && hasVersionTable) {
    throw new Error(
      "Invalid ZoroCoding schema metadata: version zero is not persisted",
    );
  }
  if (![0, 1, 2, 3, 4, SCHEMA_VERSION].includes(version)) {
    throw new Error(
      `Unsupported ZoroCoding database schema ${version}`,
    );
  }

  database.transaction(() => {
    createBaseTables(database);
    if (version === 0) {
      database.prepare("INSERT INTO schema_version(version) VALUES (4)").run();
      migrateV3ToV4(database);
      migrateV4ToV5(database);
      return;
    }
    if (version === 1) {
      migrateV1ToV2(database);
      version = 2;
    }
    if (version === 2) {
      migrateV2ToV3(database);
      version = 3;
    }
    if (version === 3) {
      migrateV3ToV4(database);
      version = 4;
    }
    if (version === 4) {
      migrateV4ToV5(database);
      version = 5;
    }
    if (version !== SCHEMA_VERSION) {
      throw new Error(`Unsupported ZoroCoding database schema ${version}`);
    }
  })();
}

export function openDatabase(filePath: string): ZoroDatabase {
  const database = new Database(filePath);
  try {
    database.pragma("foreign_keys = ON");
    migrate(database);
    if (filePath !== ":memory:") {
      database.pragma("journal_mode = WAL");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export interface DatabaseOpenResult {
  database: ZoroDatabase;
  readOnly: boolean;
  backupPath: string | null;
  recoveryMessage: string | null;
}

export function openDatabaseWithRecovery(
  filePath: string,
  now: () => number = Date.now,
): DatabaseOpenResult {
  try {
    return {
      database: openDatabase(filePath),
      readOnly: false,
      backupPath: null,
      recoveryMessage: null,
    };
  } catch (error) {
    if (filePath === ":memory:" || !existsSync(filePath)) {
      throw error;
    }
    const backupPath = `${filePath}.backup-${now()}`;
    copyFileSync(filePath, backupPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${filePath}${suffix}`)) {
        copyFileSync(`${filePath}${suffix}`, `${backupPath}${suffix}`);
      }
    }
    try {
      const database = new Database(filePath, {
        readonly: true,
        fileMustExist: true,
      });
      database.pragma("foreign_keys = ON");
      return {
        database,
        readOnly: true,
        backupPath,
        recoveryMessage:
          error instanceof Error
            ? error.message
            : "数据库迁移失败，已切换为只读模式。",
      };
    } catch (recoveryError) {
      throw new Error(
        `ZoroCoding 数据库无法安全打开，备份位于 ${backupPath}。`,
        { cause: recoveryError },
      );
    }
  }
}
