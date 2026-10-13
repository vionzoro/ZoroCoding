import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, openDatabaseWithRecovery } from "../../src/main/persistence/database";
import { IntegrationSettingsRepository } from "../../src/main/persistence/integrationSettingsRepository";
import { StorageWriteGate } from "../../src/main/persistence/liveWriteGate";
import { SecretStore } from "../../src/main/secrets/secretStore";
import { updateIntegrationSettingsRequestSchema } from "../../src/shared/ipc";

const crypto = {
  encryptString: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString(),
};

describe("integration settings", () => {
  let directory: string;
  let database: ReturnType<typeof openDatabase>;
  let secrets: SecretStore;
  let repository: IntegrationSettingsRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "integration-settings-"));
    database = openDatabase(join(directory, "settings.sqlite"));
    secrets = new SecretStore(join(directory, "secrets"), crypto);
    repository = new IntegrationSettingsRepository(database, secrets);
  });

  afterEach(async () => {
    if (database.open) database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("defaults to disabled without writing a row or accessing secrets", () => {
    const get = vi.spyOn(secrets, "get");
    expect(repository.get("optional-service")).toEqual({
      id: "optional-service", enabled: false, endpoint: "", keySuffix: "", updatedAt: 0,
    });
    expect(database.prepare("SELECT COUNT(*) FROM integration_settings").pluck().get()).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });

  it("migrates version 3 and preserves existing data across reopening", async () => {
    database.exec("DROP TABLE integration_settings; UPDATE schema_version SET version = 3;");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run("project", "项目", "relative-project", 1);
    database.close();
    database = openDatabase(join(directory, "settings.sqlite"));
    repository = new IntegrationSettingsRepository(database, secrets);
    expect(database.prepare("SELECT version FROM schema_version").pluck().get()).toBe(4);
    expect(database.prepare("SELECT name FROM projects").pluck().get()).toBe("项目");
    await repository.update({ id: "optional-service", token: "saved-token" }, 1);
    database.close();
    database = openDatabase(join(directory, "settings.sqlite"));
    repository = new IntegrationSettingsRepository(database, secrets);
    expect(repository.get("optional-service")).toMatchObject({ enabled: false, keySuffix: "oken" });
    expect(await secrets.get(repository.listSecretRefs()[0])).toBe("saved-token");
  });

  it("backs up a failed migration and reads disabled defaults without creating the missing table", async () => {
    database.exec(`
      DROP TABLE integration_settings;
      UPDATE schema_version SET version = 3;
      CREATE TRIGGER reject_migration BEFORE UPDATE ON schema_version
      WHEN NEW.version = 4 BEGIN SELECT RAISE(ABORT, 'migration failed'); END;
    `);
    database.close();
    const recovered = openDatabaseWithRecovery(join(directory, "settings.sqlite"), () => 123);
    database = recovered.database;
    repository = new IntegrationSettingsRepository(database, secrets);
    expect(recovered.readOnly).toBe(true);
    expect(recovered.recoveryMessage).toContain("migration failed");
    expect(await readFile(recovered.backupPath!)).toEqual(await readFile(join(directory, "settings.sqlite")));
    expect(repository.get("optional-service").enabled).toBe(false);
    expect(repository.listSecretRefs()).toEqual([]);
    await expect(repository.update({ id: "optional-service", token: "saved-token" }, 1)).rejects.toThrow("只读");
    expect(database.prepare("SELECT version FROM schema_version").pluck().get()).toBe(3);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'integration_settings'").get()).toBeUndefined();
  });

  it("reads saved suffixes in recovery and rejects writes before changing secrets", async () => {
    await repository.update({ id: "optional-service", token: "saved-token" }, 1);
    const reference = repository.listSecretRefs()[0];
    database.exec("UPDATE schema_version SET version = 999");
    database.close();
    database = openDatabaseWithRecovery(join(directory, "settings.sqlite")).database;
    repository = new IntegrationSettingsRepository(database, secrets);
    expect(repository.get("optional-service").keySuffix).toBe("oken");
    expect(repository.listSecretRefs()).toEqual([reference]);
    await expect(repository.update({ id: "optional-service", token: "replacement-token" }, 2)).rejects.toThrow("只读");
    expect(await secrets.get(reference)).toBe("saved-token");
  });

  it("keeps disabled integration and provider secrets and removes true orphans", async () => {
    await repository.update({ id: "optional-service", token: "integration-token" }, 1);
    await secrets.put("provider/test", "provider-token");
    await secrets.put("orphan", "orphan-token");
    const references = repository.listSecretRefs();
    await secrets.reconcile(["provider/test", ...references]);
    expect(await secrets.get(references[0])).toBe("integration-token");
    expect(await secrets.get("provider/test")).toBe("provider-token");
    expect(await secrets.get("orphan")).toBeNull();

  });

  it("retains, rotates and clears tokens without exposing them or refs", async () => {
    await repository.update({ id: "optional-service", token: "first-token" }, 1);
    const firstReference = repository.listSecretRefs()[0];
    expect(JSON.stringify(repository.get("optional-service"))).not.toContain("first-token");
    expect(repository.get("optional-service")).not.toHaveProperty("secretRef");
    await repository.update({ id: "optional-service", enabled: true, endpoint: "https://192.0.2.1/review" }, 2);
    expect(repository.listSecretRefs()).toEqual([firstReference]);
    await repository.update({ id: "optional-service", token: "second-token" }, 3);
    expect(await secrets.get(firstReference)).toBeNull();
    const nextReference = repository.listSecretRefs()[0];
    expect(await secrets.get(nextReference)).toBe("second-token");
    await repository.update({ id: "optional-service", token: "" }, 4);
    expect(repository.get("optional-service").keySuffix).toBe("");
    expect(repository.listSecretRefs()).toEqual([]);
    expect(await secrets.get(nextReference)).toBeNull();
  });

  it("cleans staged tokens after a failed database write and keeps the previous token", async () => {
    await repository.update({ id: "optional-service", token: "first-token" }, 1);
    const reference = repository.listSecretRefs()[0];
    database.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON integration_settings
      BEGIN SELECT RAISE(ABORT, 'write failed'); END;`);
    const remove = vi.spyOn(secrets, "remove");
    await expect(repository.update({ id: "optional-service", token: "second-token" }, 2)).rejects.toThrow("write failed");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await secrets.get(remove.mock.calls[0][0])).toBeNull();
    expect(await secrets.get(reference)).toBe("first-token");
    expect(repository.listSecretRefs()).toEqual([reference]);
  });

  it("keeps the active token reference valid after concurrent updates", async () => {
    await repository.update({ id: "optional-service", token: "first-token" }, 1);
    await Promise.all([
      repository.update({ id: "optional-service", token: "second-token" }, 2),
      repository.update({ id: "optional-service", token: "third-token" }, 3),
    ]);
    const references = repository.listSecretRefs();
    expect(references).toHaveLength(1);
    const token = await secrets.get(references[0]);
    expect(["second-token", "third-token"]).toContain(token);
    expect(repository.get("optional-service").keySuffix).toBe(token!.slice(-4));
    await secrets.reconcile(references);
    expect(await secrets.get(references[0])).toBe(token);
  });

  it("checks storage availability again after writing a staged token", async () => {
    let writable = true;
    secrets = new SecretStore(join(directory, "secrets"), crypto, undefined, {
      afterChmod: async () => { writable = false; },
    });
    repository = new IntegrationSettingsRepository(database, secrets, new StorageWriteGate(() => writable));
    await expect(repository.update({ id: "optional-service", token: "saved-token" }, 1)).rejects.toThrow("已断开");
    expect(repository.listSecretRefs()).toEqual([]);
  });
});

describe("integration endpoint validation", () => {
  it.each(["https://192.0.2.1/review", "http://127.0.0.1:8080/review", "http://[::1]:8080/review"])("accepts %s", (endpoint) => {
    expect(updateIntegrationSettingsRequestSchema.safeParse({ id: "optional-service", enabled: true, endpoint }).success).toBe(true);
  });

  it.each(["", "http://192.0.2.1/review", "ftp://127.0.0.1/review", "https://user:password@192.0.2.1/review", "https://192.0.2.1/review?token=secret", "https://192.0.2.1/review#fragment"])("rejects %s before writing secrets", (endpoint) => {
    expect(updateIntegrationSettingsRequestSchema.safeParse({ id: "optional-service", enabled: true, endpoint }).success).toBe(false);
  });

  it("rejects short tokens and renderer-supplied secret references", () => {
    expect(updateIntegrationSettingsRequestSchema.safeParse({ id: "optional-service", token: "tiny" }).success).toBe(false);
    expect(updateIntegrationSettingsRequestSchema.safeParse({ id: "optional-service", secretRef: "provider/test" }).success).toBe(false);
  });
});
