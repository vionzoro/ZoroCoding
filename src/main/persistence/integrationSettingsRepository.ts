import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  integrationIdRequestSchema,
  integrationSettingsViewSchema,
  updateIntegrationSettingsRequestSchema,
  type IntegrationSettingsView,
  type UpdateIntegrationSettingsRequest,
} from "../../shared/ipc";
import type { SecretStore } from "../secrets/secretStore";
import type { ZoroDatabase } from "./database";
import { allowWrites, type LiveWriteGate } from "./liveWriteGate";

interface IntegrationSettingsRow {
  id: string;
  enabled: 0 | 1;
  endpoint: string;
  secret_ref: string | null;
  key_suffix: string;
  updated_at: number;
  options_json?: string;
}

export class IntegrationSettingsRepository {
  constructor(
    private readonly database: ZoroDatabase,
    private readonly secrets: SecretStore,
    private readonly writeGate: LiveWriteGate = allowWrites,
  ) {}

  get(id: string): IntegrationSettingsView {
    const request = integrationIdRequestSchema.parse({ id });
    const row = this.getRow(request.id);
    return integrationSettingsViewSchema.parse({
      id: request.id,
      enabled: row?.enabled === 1,
      endpoint: row?.endpoint ?? "",
      keySuffix: row?.key_suffix ?? "",
      updatedAt: row?.updated_at ?? 0,
      ...(row?.options_json && row.options_json !== "{}"
        ? { options: JSON.parse(row.options_json) }
        : {}),
    });
  }

  listSecretRefs(): string[] {
    if (this.hasMissingRecoveryTable()) return [];
    const rows = this.database.prepare(
      "SELECT secret_ref FROM integration_settings WHERE secret_ref IS NOT NULL",
    ).all() as Array<{ secret_ref: string }>;
    return rows.map((row) => z.string().min(1).parse(row.secret_ref));
  }

  async update(
    input: UpdateIntegrationSettingsRequest,
    now: number,
  ): Promise<IntegrationSettingsView> {
    this.assertWritable();
    const parsed = updateIntegrationSettingsRequestSchema.parse(input);
    const updatedAt = z.number().int().nonnegative().parse(now);
    const newSecretRef = parsed.token
      ? `integration/${parsed.id}/${randomUUID()}`
      : null;
    if (newSecretRef !== null) {
      await this.secrets.put(newSecretRef, parsed.token!);
    }
    let previousSecretRef: string | null = null;
    try {
      // Read after the asynchronous secret write so concurrent updates cannot
      // restore an already replaced reference.
      this.assertWritable();
      const current = this.getRow(parsed.id);
      previousSecretRef = current?.secret_ref ?? null;
      const secretRef = parsed.token === undefined ? previousSecretRef : newSecretRef;
      const keySuffix = parsed.token === undefined
        ? current?.key_suffix ?? ""
        : parsed.token.slice(-4);
      const optionsJson = parsed.options === undefined
        ? current?.options_json ?? "{}"
        : JSON.stringify(parsed.options);
      this.database.prepare(`
        INSERT INTO integration_settings(id, enabled, endpoint, secret_ref, key_suffix, updated_at, options_json)
        VALUES (@id, @enabled, @endpoint, @secretRef, @keySuffix, @updatedAt, @optionsJson)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          endpoint = excluded.endpoint,
          secret_ref = excluded.secret_ref,
          key_suffix = excluded.key_suffix,
          updated_at = excluded.updated_at,
          options_json = excluded.options_json
      `).run({
        id: parsed.id,
        enabled: parsed.enabled ? 1 : 0,
        endpoint: parsed.endpoint,
        secretRef,
        keySuffix,
        updatedAt,
        optionsJson,
      });
    } catch (error) {
      if (newSecretRef !== null) {
        await this.secrets.remove(newSecretRef).catch(() => {});
      }
      throw error;
    }
    if (parsed.token !== undefined && previousSecretRef !== null) {
      // A failed cleanup leaves an orphan for the next writable startup.
      await this.secrets.remove(previousSecretRef).catch(() => {});
    }
    return this.get(parsed.id);
  }

  private getRow(id: string): IntegrationSettingsRow | undefined {
    if (this.hasMissingRecoveryTable()) return undefined;
    return this.database.prepare(
      "SELECT * FROM integration_settings WHERE id = ?",
    ).get(id) as IntegrationSettingsRow | undefined;
  }

  private hasMissingRecoveryTable(): boolean {
    return this.database.readonly && this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_settings'",
    ).get() === undefined;
  }

  private assertWritable(): void {
    this.writeGate.assertWritable();
    if (this.database.readonly) {
      throw new Error("当前处于只读恢复模式，不能修改集成设置。");
    }
  }
}
