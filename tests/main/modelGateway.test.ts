import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../../src/main/persistence/database";
import { ProviderRepository } from "../../src/main/persistence/providerRepository";
import {
  KIMI_PROVIDER_TEMPLATE,
  ModelGateway,
} from "../../src/main/models/modelGateway";
import { PROVIDER_TEMPLATES } from "../../src/main/models/providerTemplates";
import { SecretStore, type SecretCrypto } from "../../src/main/secrets/secretStore";

const tempDirectories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

const protectedProviderAliases = [
  {
    id: "cerebras",
    canonical: "https://api.cerebras.ai/v1",
    alias: "https://api.cerebras.ai./v1",
  },
  {
    id: "sambanova",
    canonical: "https://api.sambanova.ai/v1",
    alias: "https://api.sambanova.ai/v%31",
  },
  {
    id: "nvidia",
    canonical: "https://integrate.api.nvidia.com/v1",
    alias: "https://integrate.api.nvidia.com./v%31",
  },
  {
    id: "zhipu",
    canonical: "https://open.bigmodel.cn/api/paas/v4",
    alias: "https://open.bigmodel.cn/api/paas/v%34",
  },
] as const;

const xorCrypto: SecretCrypto = {
  encryptString(value) {
    return Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xaa));
  },
  decryptString(value) {
    return Buffer.from(value.map((byte) => byte ^ 0xaa)).toString("utf8");
  },
};

async function harness(
  fetchImpl: typeof fetch,
  isProviderInUse: (providerId: string) => boolean = () => false,
  createSecretVersion?: () => string,
  now: () => number = Date.now,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "zoro-secrets-"));
  tempDirectories.push(directory);
  const database = openDatabase(":memory:");
  databases.push(database);
  const repository = new ProviderRepository(database);
  const secrets = new SecretStore(directory, xorCrypto);
  return {
    repository,
    secrets,
    gateway: new ModelGateway(
      repository,
      secrets,
      fetchImpl,
      isProviderInUse,
      createSecretVersion,
      now,
    ),
    directory,
  };
}

async function seedLegacyProtectedProvider(
  repository: ProviderRepository,
  secrets: SecretStore,
  baseUrl = "https://api.cerebras.ai/v1",
): Promise<void> {
  repository.create({
    id: "legacy-protected",
    name: "Cerebras Legacy",
    kind: "openai-compatible",
    baseUrl,
    modelId: "legacy-model",
    contextLength: 128_000,
    headers: {},
    secretRef: "provider/legacy-protected/v1",
    keySuffix: "-key",
    isDefault: false,
    connectionStatus: "untested",
    connectionMessage: null,
    lastTestedAt: null,
    billingNote: "旧计费备注",
    dashboardUrl: "",
    createdAt: 100,
    updatedAt: 100,
  });
  await secrets.put(
    "provider/legacy-protected/v1",
    "test-legacy-key",
  );
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SecretStore", () => {
  it("round-trips encrypted values without writing plaintext", async () => {
    const { secrets, directory } = await harness(
      (async () => new Response()) as typeof fetch,
    );

    await secrets.put("provider/provider-1", "secret-value");

    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(directory),
    );
    const stored = await readFile(path.join(directory, entries[0]));
    expect(stored.toString("utf8")).not.toContain("secret-value");
    expect(await secrets.get("provider/provider-1")).toBe("secret-value");
    await secrets.remove("provider/provider-1");
    expect(await secrets.get("provider/provider-1")).toBeNull();
  });

  it.each(["afterWrite", "afterChmod"] as const)("leaves a staged tmp when the gate closes %s", async (point) => {
    const directory = await mkdtemp(path.join(tmpdir(), "zoro-secrets-"));
    tempDirectories.push(directory);
    let open = true;
    const gate = { assertWritable: () => { if (!open) throw new Error("closed"); } };
    const secrets = new SecretStore(directory, xorCrypto, gate, {
      [point]: async () => { open = false; },
    });
    await expect(secrets.put("provider/test/v1", "key")).rejects.toThrow("closed");
    expect((await readdir(directory)).some((entry) => entry.includes(".tmp"))).toBe(true);
    open = true;
    await secrets.reconcile([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reconcile removes unreferenced final and temporary secrets while preserving referenced secrets", async () => {
    const versions = ["referenced-version", "orphan-version"];
    const { gateway, repository, secrets, directory } = await harness(
      (async () => Response.json({})) as typeof fetch,
      () => false,
      () => versions.shift()!,
    );
    await gateway.createProvider({
      id: "referenced-provider",
      name: "Referenced",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-key-referenced",
      isDefault: false,
      now: 1,
    });
    await gateway.createProvider({
      id: "orphan-provider",
      name: "Orphan",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-key-orphan",
      isDefault: false,
      now: 2,
    });
    const referencedSecretRef =
      repository.get("referenced-provider")!.secretRef;
    const orphanSecretRef = repository.get("orphan-provider")!.secretRef;
    repository.remove("orphan-provider");
    await writeFile(
      path.join(directory, ".staged-secret.interrupted.tmp"),
      "encrypted-staging-fixture",
    );

    await secrets.reconcile([referencedSecretRef]);

    expect(referencedSecretRef).toBe(
      "provider/referenced-provider/referenced-version",
    );
    expect(orphanSecretRef).toBe("provider/orphan-provider/orphan-version");
    expect(await secrets.get(referencedSecretRef)).toBe("test-key-referenced");
    expect(await secrets.get(orphanSecretRef)).toBeNull();
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("reconcile surfaces an unlink failure instead of continuing startup", async () => {
    const { secrets, directory } = await harness(
      (async () => Response.json({})) as typeof fetch,
    );
    await mkdir(path.join(directory, "cleanup-blocked.secret"));

    await expect(secrets.reconcile([])).rejects.toMatchObject({
      code: expect.stringMatching(/EISDIR|EPERM/),
    });
  });
});

describe("ModelGateway provider configuration", () => {
  it("returns only a safe provider snapshot without accessing its API key", async () => {
    const { gateway, repository } = await harness(
      (async () => new Response()) as typeof fetch,
    );
    const config = {
      id: "groq",
      name: "Groq",
      kind: "openai-compatible" as const,
      baseUrl: "https://api.groq.com/openai/v1",
      modelId: "qwen/qwen3.6-27b",
      contextLength: 131_072,
      headers: {},
      secretRef: "provider/groq",
      keySuffix: "1234",
      isDefault: false,
      connectionStatus: "untested" as const,
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "免费额度",
      dashboardUrl: "https://console.groq.com/keys",
      createdAt: 100,
      updatedAt: 100,
    };
    repository.create(config);

    const snapshot = gateway.getProviderSnapshot("groq");

    expect(snapshot).toEqual({
      providerId: "groq",
      name: "Groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      modelId: "qwen/qwen3.6-27b",
      contextLength: 131_072,
    });
    expect(snapshot).not.toHaveProperty("secretRef");
    expect(snapshot).not.toHaveProperty("headers");
    expect(snapshot).not.toHaveProperty("keySuffix");
    expect(snapshot).not.toHaveProperty("connectionStatus");
  });
});

describe("ModelGateway", () => {
  it.each(protectedProviderAliases)(
    "rejects $id alias save before authenticated discovery",
    async ({ alias }) => {
      const { gateway, repository } = await harness(
        (async () => Response.json({ data: [] })) as typeof fetch,
      );

      await expect(
        gateway.createProvider({
          id: "protected-alias",
          name: "Protected Alias",
          kind: "openai-compatible",
          baseUrl: alias,
          modelId: "alias-model",
          contextLength: 128_000,
          headers: {},
          apiKey: "test-alias-key",
          isDefault: false,
          now: 100,
        }),
      ).rejects.toThrow("发现");
      expect(repository.get("protected-alias")).toBeNull();
    },
  );

  it.each(protectedProviderAliases)(
    "canonicalizes $id alias discovery, fingerprint, and stored URL",
    async ({ alias, canonical }) => {
      let requestedUrl = "";
      const { gateway, repository } = await harness(
        (async (input) => {
          requestedUrl = String(input);
          return Response.json({ data: [{ id: "alias-model" }] });
        }) as typeof fetch,
      );

      await gateway.discoverDraftModels({
        baseUrl: alias,
        apiKey: "test-alias-key",
        headers: {},
      });
      await gateway.createProvider({
        id: "protected-alias",
        name: "Protected Alias",
        kind: "openai-compatible",
        baseUrl: alias,
        modelId: "alias-model",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-alias-key",
        isDefault: false,
        now: 100,
      });

      expect(requestedUrl).toBe(`${canonical}/models`);
      expect(repository.get("protected-alias")?.baseUrl).toBe(canonical);
    },
  );

  it.each(protectedProviderAliases)(
    "rejects $id model update through an alias without matching discovery",
    async ({ alias, canonical }) => {
      const { gateway, repository, secrets } = await harness(
        (async () => Response.json({ data: [] })) as typeof fetch,
      );
      await seedLegacyProtectedProvider(repository, secrets, canonical);

      await expect(
        gateway.updateProvider("legacy-protected", {
          name: "Protected Alias",
          kind: "openai-compatible",
          baseUrl: alias,
          modelId: "alias-bypass-model",
          contextLength: 128_000,
          headers: {},
          isDefault: false,
          now: 200,
        }),
      ).rejects.toThrow("发现");
      expect(repository.get("legacy-protected")?.modelId).toBe(
        "legacy-model",
      );
    },
  );

  it("requires discovery when changing from a protected identity to a custom identity", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () =>
        Response.json({ data: [{ id: "custom-model" }] })) as typeof fetch,
    );
    await seedLegacyProtectedProvider(repository, secrets);
    const update = {
      name: "Migrated Custom Provider",
      kind: "openai-compatible" as const,
      baseUrl: "https://custom.example.com/v1",
      modelId: "custom-model",
      contextLength: 128_000,
      headers: {},
      isDefault: false,
      now: 200,
    };

    await expect(
      gateway.updateProvider("legacy-protected", update),
    ).rejects.toThrow("发现");

    await gateway.discoverDraftModels({
      baseUrl: update.baseUrl,
      apiKey: "test-legacy-key",
      headers: update.headers,
    });
    await expect(
      gateway.updateProvider("legacy-protected", update),
    ).resolves.toMatchObject({
      baseUrl: "https://custom.example.com/v1",
      modelId: "custom-model",
    });
  });

  it.each([
    "https://api.cerebras.ai/v1",
    "https://api.sambanova.ai/v1",
    "https://integrate.api.nvidia.com/v1",
    "https://open.bigmodel.cn/api/paas/v4",
  ])("rejects protected template save before authenticated discovery: %s", async (baseUrl) => {
    const { gateway, repository } = await harness(
      (async () => Response.json({ data: [] })) as typeof fetch,
    );

    await expect(
      gateway.createProvider({
        id: "protected-provider",
        name: "Protected",
        kind: "openai-compatible",
        baseUrl,
        modelId: "protected-model",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-protected-key",
        isDefault: false,
        now: 100,
      }),
    ).rejects.toThrow("发现");
    expect(repository.get("protected-provider")).toBeNull();
  });

  it("allows a protected template save after discovering the exact model with the same config", async () => {
    const { gateway, repository } = await harness(
      (async () =>
        Response.json({ data: [{ id: "cerebras-code-model" }] })) as typeof fetch,
    );
    const discovery = {
      baseUrl: "https://api.cerebras.ai/v1/",
      apiKey: "test-protected-key",
      headers: { "X-Team": "  zoro  " },
    };

    await gateway.discoverDraftModels(discovery);
    await gateway.createProvider({
      id: "protected-provider",
      name: "Cerebras",
      kind: "openai-compatible",
      baseUrl: "https://api.cerebras.ai/v1",
      modelId: "cerebras-code-model",
      contextLength: 128_000,
      headers: { "x-team": "zoro" },
      apiKey: "test-protected-key",
      isDefault: false,
      now: 100,
    });

    expect(repository.get("protected-provider")).toMatchObject({
      modelId: "cerebras-code-model",
      baseUrl: "https://api.cerebras.ai/v1",
    });
  });

  it("scopes protected discovery authorization to the credential and exact model", async () => {
    const { gateway } = await harness(
      (async () =>
        Response.json({ data: [{ id: "discovered-model" }] })) as typeof fetch,
    );
    await gateway.discoverDraftModels({
      baseUrl: "https://api.cerebras.ai/v1",
      apiKey: "test-original-key",
      headers: {},
    });

    await expect(
      gateway.createProvider({
        id: "wrong-key",
        name: "Cerebras",
        kind: "openai-compatible",
        baseUrl: "https://api.cerebras.ai/v1",
        modelId: "discovered-model",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-other-key",
        isDefault: false,
        now: 100,
      }),
    ).rejects.toThrow("发现");
    await expect(
      gateway.createProvider({
        id: "wrong-model",
        name: "Cerebras",
        kind: "openai-compatible",
        baseUrl: "https://api.cerebras.ai/v1",
        modelId: "not-discovered",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-original-key",
        isDefault: false,
        now: 100,
      }),
    ).rejects.toThrow("发现");
    await expect(
      gateway.createProvider({
        id: "wrong-headers",
        name: "Cerebras",
        kind: "openai-compatible",
        baseUrl: "https://api.cerebras.ai/v1",
        modelId: "discovered-model",
        contextLength: 128_000,
        headers: { "X-Team": "different" },
        apiKey: "test-original-key",
        isDefault: false,
        now: 100,
      }),
    ).rejects.toThrow("发现");
  });

  it("allows metadata-only edits to an unchanged legacy protected provider", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () => Response.json({})) as typeof fetch,
    );
    await seedLegacyProtectedProvider(repository, secrets);

    await gateway.updateProvider("legacy-protected", {
      name: "Cerebras Renamed",
      kind: "openai-compatible",
      baseUrl: "https://api.cerebras.ai/v1/",
      modelId: "legacy-model",
      contextLength: 128_000,
      headers: {},
      isDefault: false,
      billingNote: "新计费备注",
      now: 200,
    });

    expect(repository.get("legacy-protected")).toMatchObject({
      name: "Cerebras Renamed",
      modelId: "legacy-model",
      billingNote: "新计费备注",
    });
  });

  it("requires discovery before changing a legacy protected model", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () =>
        Response.json({ data: [{ id: "new-model" }] })) as typeof fetch,
    );
    await seedLegacyProtectedProvider(repository, secrets);
    const update = {
      name: "Cerebras Legacy",
      kind: "openai-compatible" as const,
      baseUrl: "https://api.cerebras.ai/v1",
      modelId: "new-model",
      contextLength: 128_000,
      headers: {},
      isDefault: false,
      now: 200,
    };

    await expect(
      gateway.updateProvider("legacy-protected", update),
    ).rejects.toThrow("发现");

    await gateway.discoverDraftModels({
      baseUrl: update.baseUrl,
      apiKey: "test-legacy-key",
      headers: update.headers,
    });
    await expect(
      gateway.updateProvider("legacy-protected", update),
    ).resolves.toMatchObject({ modelId: "new-model" });
  });

  it("requires discovery before rotating a legacy protected credential", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () =>
        Response.json({ data: [{ id: "legacy-model" }] })) as typeof fetch,
    );
    await seedLegacyProtectedProvider(repository, secrets);
    const update = {
      name: "Cerebras Legacy",
      kind: "openai-compatible" as const,
      baseUrl: "https://api.cerebras.ai/v1",
      modelId: "legacy-model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-rotated-key",
      isDefault: false,
      now: 200,
    };

    await expect(
      gateway.updateProvider("legacy-protected", update),
    ).rejects.toThrow("发现");

    await gateway.discoverDraftModels({
      baseUrl: update.baseUrl,
      apiKey: update.apiKey,
      headers: update.headers,
    });
    await expect(
      gateway.updateProvider("legacy-protected", update),
    ).resolves.toMatchObject({ keySuffix: "-key" });
  });

  it("discovers draft models without persisting the fixture key", async () => {
    const requests: Request[] = [];
    const { gateway, repository } = await harness(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ data: [{ id: "qwen-coder" }] });
      }) as typeof fetch,
    );

    await expect(
      gateway.discoverDraftModels({
        baseUrl: "https://api.example.com/v1/",
        apiKey: "test-discovery-key",
        headers: {},
      }),
    ).resolves.toEqual([{ id: "qwen-coder", label: "qwen-coder" }]);
    expect(requests[0].url).toBe("https://api.example.com/v1/models");
    expect(repository.list()).toEqual([]);
  });

  it("invalidates all in-flight provider checks without cache or health after-effects", async () => {
    const pending: Array<{
      url: string;
      signal: AbortSignal | null;
      resolve(response: Response): void;
    }> = [];
    const fetchImpl = ((input, init) =>
      new Promise<Response>((resolve) => {
        pending.push({
          url: String(input),
          signal: init?.signal ?? null,
          resolve,
        });
      })) as typeof fetch;
    const { gateway, repository } = await harness(
      fetchImpl,
      () => false,
      () => "storage-loss-version",
      () => 500,
    );
    await gateway.createProvider({
      id: "saved-provider",
      name: "Saved provider",
      kind: "openai-compatible",
      baseUrl: "https://saved.example.com/v1",
      modelId: "saved-model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-saved-storage-loss-key",
      isDefault: false,
      now: 100,
    });
    const updateHealth = vi.spyOn(repository, "updateHealth");

    const discovery = gateway.discoverDraftModels({
      baseUrl: "https://api.cerebras.ai/v1",
      apiKey: "test-late-discovery-key",
      headers: {},
    });
    const draftTest = gateway.testDraft({
      name: "Draft provider",
      kind: "openai-compatible",
      baseUrl: "https://draft.example.com/v1",
      modelId: "draft-model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-draft-storage-loss-key",
    });
    const savedTest = gateway.testAndRecordProvider("saved-provider");

    await vi.waitFor(() => expect(pending).toHaveLength(3));
    await gateway.interruptForStorageLoss();
    expect(pending.every((request) => request.signal?.aborted === true)).toBe(
      true,
    );

    for (const request of pending) {
      request.resolve(
        request.url.endsWith("/models")
          ? Response.json({ data: [{ id: "late-model" }] })
          : Response.json({ choices: [] }),
      );
    }

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
    await expect(draftTest).rejects.toMatchObject({ name: "AbortError" });
    await expect(savedTest).rejects.toMatchObject({ name: "AbortError" });
    expect(updateHealth).not.toHaveBeenCalled();
    await expect(
      gateway.createProvider({
        id: "late-protected-provider",
        name: "Late protected provider",
        kind: "openai-compatible",
        baseUrl: "https://api.cerebras.ai/v1",
        modelId: "late-model",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-late-discovery-key",
        isDefault: false,
        now: 600,
      }),
    ).rejects.toThrow("发现");
  });

  it("clears completed protected discovery authorization on storage loss", async () => {
    const { gateway } = await harness(
      (async () =>
        Response.json({ data: [{ id: "protected-model" }] })) as typeof fetch,
    );
    const discovery = {
      baseUrl: "https://api.cerebras.ai/v1",
      apiKey: "test-cleared-discovery-key",
      headers: {},
    };

    await gateway.discoverDraftModels(discovery);
    await gateway.interruptForStorageLoss();

    await expect(
      gateway.createProvider({
        id: "cleared-protected-provider",
        name: "Cleared protected provider",
        kind: "openai-compatible",
        baseUrl: discovery.baseUrl,
        modelId: "protected-model",
        contextLength: 128_000,
        headers: discovery.headers,
        apiKey: discovery.apiKey,
        isDefault: false,
        now: 100,
      }),
    ).rejects.toThrow("发现");
  });

  it("does not record failed health when an external signal cancels a saved provider test", async () => {
    let requestSignal: AbortSignal | null = null;
    const fetchImpl = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? null;
        requestSignal?.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("test provider request cancelled", "AbortError"),
            ),
          { once: true },
        );
      })) as typeof fetch;
    const { gateway, repository } = await harness(
      fetchImpl,
      () => false,
      () => "external-abort-version",
      () => 700,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "Saved provider",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "saved-model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-external-abort-key",
      isDefault: false,
      now: 100,
    });
    const updateHealth = vi.spyOn(repository, "updateHealth");
    const external = new AbortController();

    const test = gateway.testAndRecordProvider(
      "provider-1",
      external.signal,
    );
    await vi.waitFor(() => expect(requestSignal).not.toBeNull());
    external.abort();

    await expect(test).rejects.toMatchObject({ name: "AbortError" });
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(updateHealth).not.toHaveBeenCalled();
  });

  it("records successful health without changing the default provider", async () => {
    const { gateway, repository } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
      () => false,
      () => "health-version",
      () => 500,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.example.com/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
      headers: {},
      apiKey: "test-health-key",
      isDefault: true,
      now: 100,
    });

    await expect(gateway.testAndRecordProvider("provider-1")).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(repository.get("provider-1")).toMatchObject({
      connectionStatus: "connected",
      connectionMessage: "连接正常",
      lastTestedAt: 500,
      isDefault: true,
    });
  });

  it("records a sanitized failed health result without storing response details", async () => {
    const { gateway, repository } = await harness(
      (async () =>
        new Response("raw-provider-response", {
          status: 401,
          headers: { "x-secret-header": "sensitive-response-header" },
        })) as typeof fetch,
      () => false,
      () => "failed-health-version",
      () => 700,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-failed-health-key",
      isDefault: false,
      now: 100,
    });

    await expect(gateway.testAndRecordProvider("provider-1")).rejects.toThrow(
      "鉴权失败",
    );
    const stored = repository.get("provider-1");
    expect(stored).toMatchObject({
      connectionStatus: "error",
      connectionMessage: "模型 API 鉴权失败，请检查 API Key。",
      lastTestedAt: 700,
    });
    expect(JSON.stringify(stored)).not.toMatch(
      /test-failed-health-key|raw-provider-response|sensitive-response-header/,
    );
  });

  it("propagates connected-health persistence failure without writing error health", async () => {
    const { gateway, repository } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
      () => false,
      () => "connected-persistence-version",
      () => 800,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-connected-persistence-key",
      isDefault: false,
      now: 100,
    });
    const localFailure = new Error("storage write gate closed");
    const updateHealth = vi
      .spyOn(repository, "updateHealth")
      .mockImplementation(() => {
        throw localFailure;
      });

    await expect(
      gateway.testAndRecordProvider("provider-1"),
    ).rejects.toBe(localFailure);
    expect(updateHealth).toHaveBeenCalledOnce();
    expect(updateHealth).toHaveBeenCalledWith("provider-1", {
      connectionStatus: "connected",
      connectionMessage: "连接正常",
      lastTestedAt: 800,
    });
  });

  it("preserves the original remote error when error-health persistence fails", async () => {
    const { gateway, repository } = await harness(
      (async () => new Response("fixture failure", { status: 401 })) as typeof fetch,
      () => false,
      () => "error-persistence-version",
      () => 900,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-error-persistence-key",
      isDefault: false,
      now: 100,
    });
    vi.spyOn(repository, "updateHealth").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(
      gateway.testAndRecordProvider("provider-1"),
    ).rejects.toMatchObject({
      failure: {
        code: "auth",
        message: "模型 API 鉴权失败，请检查 API Key。",
      },
    });
  });

  it("creates and tests a compatible provider", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
      });
      return Response.json({
        choices: [{ message: { role: "assistant", content: "OK" } }],
      });
    }) as typeof fetch;
    const { gateway, repository } = await harness(fetchImpl);

    const created = await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1/",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "secret-value",
      isDefault: true,
      now: 100,
    });
    const connection = await gateway.testProvider(created.id);

    expect(repository.get(created.id)).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      keySuffix: "alue",
      isDefault: true,
    });
    expect(connection.ok).toBe(true);
    expect(requests).toEqual([
      {
        url: "https://api.example.com/v1/chat/completions",
        authorization: "Bearer secret-value",
      },
    ]);
  });

  it("successful provider deletion removes the captured current versioned secret ref", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "secret-value",
      isDefault: false,
      now: 100,
    });

    const secretRef = repository.get("provider-1")!.secretRef;
    expect(secretRef).not.toBe("provider/provider-1");
    await gateway.deleteProvider("provider-1");

    expect(await secrets.get(secretRef)).toBeNull();
    expect(repository.get("provider-1")).toBeNull();
  });

  it("successful key rotation with cleanup blocked leaves the old ref as a safe orphan and restart reconciliation removes it", async () => {
    const versions = ["initial-version", "rotated-version"];
    const { gateway, repository, secrets } = await harness(
      (async () => Response.json({})) as typeof fetch,
      () => false,
      () => versions.shift()!,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "Team model",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-key-before-rotation",
      isDefault: false,
      now: 1,
    });
    const oldSecretRef = repository.get("provider-1")!.secretRef;
    const blockedCleanup = vi
      .spyOn(secrets, "remove")
      .mockRejectedValueOnce(new Error("cleanup blocked"));

    await gateway.updateProvider("provider-1", {
      name: "Team model",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "model",
      contextLength: 128_000,
      headers: {},
      apiKey: "test-key-after-rotation",
      isDefault: false,
      now: 2,
    });

    const currentSecretRef = repository.get("provider-1")!.secretRef;
    blockedCleanup.mockRestore();
    expect(oldSecretRef).toBe("provider/provider-1/initial-version");
    expect(currentSecretRef).toBe("provider/provider-1/rotated-version");
    expect(await secrets.get(oldSecretRef)).toBe("test-key-before-rotation");
    expect(await secrets.get(currentSecretRef)).toBe(
      "test-key-after-rotation",
    );

    await secrets.reconcile([currentSecretRef]);

    expect(await secrets.get(oldSecretRef)).toBeNull();
    expect(await secrets.get(currentSecretRef)).toBe(
      "test-key-after-rotation",
    );
  });

  it("createProvider metadata failure preserves the primary error and leaves an unreferenced version", async () => {
    const { gateway, repository, secrets, directory } = await harness((async () => Response.json({})) as typeof fetch);
    const failure = new Error("metadata failed");
    vi.spyOn(repository, "create").mockImplementation(() => { throw failure; });
    await expect(gateway.createProvider({ id: "provider-1", name: "n", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", modelId: "m", contextLength: 128_000, headers: {}, apiKey: "new-key", isDefault: false, now: 1 })).rejects.toBe(failure);
    expect(repository.get("provider-1")).toBeNull();
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".secret"))).toHaveLength(1);
    await secrets.reconcile([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("updateProvider metadata failure keeps the old ref and key while leaving a new orphan", async () => {
    const { gateway, repository, secrets, directory } = await harness((async () => Response.json({})) as typeof fetch);
    await gateway.createProvider({ id: "provider-1", name: "n", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", modelId: "m", contextLength: 128_000, headers: {}, apiKey: "old-key", isDefault: false, now: 1 });
    const oldRef = repository.get("provider-1")!.secretRef;
    const failure = new Error("update failed");
    vi.spyOn(repository, "update").mockImplementation(() => { throw failure; });
    await expect(gateway.updateProvider("provider-1", { name: "n", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", modelId: "m", contextLength: 128_000, headers: {}, apiKey: "new-key", isDefault: false, now: 2 })).rejects.toBe(failure);
    expect(repository.get("provider-1")!.secretRef).toBe(oldRef);
    expect(await secrets.get(oldRef)).toBe("old-key");
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".secret"))).toHaveLength(2);
    await secrets.reconcile([oldRef]);
    expect(await secrets.get(oldRef)).toBe("old-key");
  });

  it("keeps the encrypted secret when provider metadata cannot be removed", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "secret-value",
      isDefault: false,
      now: 100,
    });
    vi.spyOn(repository, "remove").mockImplementation(() => {
      throw new Error("database is read-only");
    });

    await expect(gateway.deleteProvider("provider-1")).rejects.toThrow(
      "read-only",
    );
    expect(await secrets.get(repository.get("provider-1")!.secretRef)).toBe("secret-value");
  });

  it("rejects an unsafe legacy provider for requests but still allows deleting it", async () => {
    const fetchImpl = vi.fn(
      async () => Response.json({ choices: [] }),
    ) as unknown as typeof fetch;
    const { gateway, repository, secrets } = await harness(fetchImpl);
    repository.create({
      id: "legacy-provider",
      name: "旧模型",
      kind: "openai-compatible",
      baseUrl: "http://169.254.169.254/v1",
      modelId: "legacy",
      contextLength: 128_000,
      headers: {},
      secretRef: "provider/legacy-provider",
      keySuffix: "alue",
      isDefault: false,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "计费规则由服务商决定",
      dashboardUrl: "",
      createdAt: 100,
      updatedAt: 100,
    });
    await secrets.put("provider/legacy-provider", "secret-value");

    await expect(gateway.testProvider("legacy-provider")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();

    await gateway.deleteProvider("legacy-provider");
    expect(repository.get("legacy-provider")).toBeNull();
    expect(await secrets.get("provider/legacy-provider")).toBeNull();
  });

  it("updates provider metadata and replaces its encrypted key", async () => {
    const { gateway, repository, secrets } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "secret-value",
      isDefault: false,
      now: 100,
    });

    await gateway.updateProvider("provider-1", {
      name: "更新后的模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v2/",
      modelId: "team-code-v2",
      contextLength: 256_000,
      headers: { "X-Team": "zoro" },
      apiKey: "replacement-key",
      isDefault: true,
      now: 200,
    });

    expect(repository.get("provider-1")).toMatchObject({
      name: "更新后的模型",
      baseUrl: "https://api.example.com/v2",
      keySuffix: "-key",
      isDefault: true,
    });
    expect(await secrets.get(repository.get("provider-1")!.secretRef)).toBe("replacement-key");
  });

  it.each([
    ["kind", { kind: "kimi" as const }],
    ["base URL", { baseUrl: "https://other.example.com/v1" }],
    ["model ID", { modelId: "other-model" }],
    ["context length", { contextLength: 256_000 }],
    ["headers", { headers: { "X-Execution": "changed" } }],
    ["API key", { apiKey: "replacement-key" }],
  ])("rejects %s edits while a provider is referenced by a resumable task", async (_label, change) => {
    const { gateway, repository } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
      (providerId) => providerId === "provider-1",
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "Original",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "original-model",
      contextLength: 128_000,
      headers: { "X-Execution": "original" },
      apiKey: "original-key",
      isDefault: false,
      now: 100,
    });

    await expect(
      gateway.updateProvider("provider-1", {
        name: "Original",
        kind: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "original-model",
        contextLength: 128_000,
        headers: { "X-Execution": "original" },
        isDefault: false,
        now: 200,
        ...change,
      }),
    ).rejects.toThrow("任务引用");
    expect(repository.get("provider-1")).toMatchObject({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "original-model",
      contextLength: 128_000,
      headers: { "X-Execution": "original" },
      keySuffix: "-key",
    });
  });

  it("rejects a protected-provider update when a task starts during secret discovery", async () => {
    let inUse = false;
    const { gateway, repository, secrets, directory } = await harness(
      (async () =>
        Response.json({ data: [{ id: "next-model" }] })) as typeof fetch,
      () => inUse,
    );
    await seedLegacyProtectedProvider(repository, secrets);
    await gateway.discoverDraftModels({
      baseUrl: "https://api.cerebras.ai/v1",
      apiKey: "test-legacy-key",
      headers: {},
    });
    const originalGet = secrets.get.bind(secrets);
    let releaseGet: (() => void) | undefined;
    let notifyGetStarted: (() => void) | undefined;
    const getStarted = new Promise<void>((resolve) => {
      notifyGetStarted = resolve;
    });
    const blockedGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    vi.spyOn(secrets, "get").mockImplementation(async (reference) => {
      const value = await originalGet(reference);
      inUse = true;
      notifyGetStarted?.();
      await blockedGet;
      return value;
    });

    const pending = gateway.updateProvider("legacy-protected", {
      name: "Cerebras Legacy",
      kind: "openai-compatible",
      baseUrl: "https://api.cerebras.ai/v1",
      modelId: "next-model",
      contextLength: 128_000,
      headers: {},
      isDefault: false,
      now: 200,
    });
    await getStarted;
    releaseGet?.();

    await expect(pending).rejects.toThrow("任务引用");
    expect(repository.get("legacy-protected")).toMatchObject({
      modelId: "legacy-model",
      secretRef: "provider/legacy-protected/v1",
      keySuffix: "-key",
    });
    expect(await originalGet("provider/legacy-protected/v1")).toBe(
      "test-legacy-key",
    );
    expect(
      (await readdir(directory)).filter((entry) =>
        entry.endsWith(".secret"),
      ),
    ).toHaveLength(1);
  });

  it("rolls back a new secret when a task starts while key rotation is being persisted", async () => {
    let inUse = false;
    const versions = ["initial-version", "rotated-version"];
    const { gateway, repository, secrets, directory } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
      () => inUse,
      () => versions.shift()!,
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "Original",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "original-model",
      contextLength: 128_000,
      headers: {},
      apiKey: "original-key",
      isDefault: false,
      now: 100,
    });
    const original = repository.get("provider-1")!;
    const originalPut = secrets.put.bind(secrets);
    let releasePut: (() => void) | undefined;
    let notifyPutFinished: (() => void) | undefined;
    const putFinished = new Promise<void>((resolve) => {
      notifyPutFinished = resolve;
    });
    const blockedPut = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    vi.spyOn(secrets, "put").mockImplementation(async (reference, value) => {
      await originalPut(reference, value);
      inUse = true;
      notifyPutFinished?.();
      await blockedPut;
    });

    const pending = gateway.updateProvider("provider-1", {
      name: "Original",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "original-model",
      contextLength: 128_000,
      headers: {},
      apiKey: "replacement-key",
      isDefault: false,
      now: 200,
    });
    await putFinished;
    expect(
      await secrets.get("provider/provider-1/rotated-version"),
    ).toBe("replacement-key");
    releasePut?.();

    await expect(pending).rejects.toThrow("任务引用");
    expect(repository.get("provider-1")).toEqual(original);
    expect(await secrets.get(original.secretRef)).toBe("original-key");
    expect(
      await secrets.get("provider/provider-1/rotated-version"),
    ).toBeNull();
    expect(
      (await readdir(directory)).filter((entry) =>
        entry.endsWith(".secret"),
      ),
    ).toHaveLength(1);
  });

  it("allows harmless metadata edits while preserving the referenced provider's execution authority", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      executionHeader: string | null;
      model: unknown;
    }> = [];
    const fetchImpl = (async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        executionHeader: headers.get("x-execution"),
        model: JSON.parse(String(init?.body)).model,
      });
      return new Response(
        'data: {"choices":[{"delta":{"content":"original"},"finish_reason":"stop"}]}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const { gateway } = await harness(
      fetchImpl,
      (providerId) => providerId === "provider-1",
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "Original",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "original-model",
      contextLength: 128_000,
      headers: { "X-Execution": "original" },
      apiKey: "original-key",
      isDefault: false,
      billingNote: "Original billing",
      dashboardUrl: "https://example.com/original",
      now: 100,
    });

    await gateway.updateProvider("provider-1", {
      name: "Renamed",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1/",
      modelId: "original-model",
      contextLength: 128_000,
      headers: { "x-execution": "original" },
      isDefault: true,
      billingNote: "Updated billing",
      dashboardUrl: "https://example.com/updated",
      now: 200,
    });
    const events = [];
    for await (const event of gateway.stream("provider-1", {
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text_delta", text: "original" });
    expect(requests).toEqual([
      {
        url: "https://api.example.com/v1/chat/completions",
        authorization: "Bearer original-key",
        executionHeader: "original",
        model: "original-model",
      },
    ]);
  });

  it("refuses to delete a provider used by a running task", async () => {
    const { gateway } = await harness(
      (async () => Response.json({ choices: [] })) as typeof fetch,
      (providerId) => providerId === "provider-1",
    );
    await gateway.createProvider({
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "secret-value",
      isDefault: false,
      now: 100,
    });

    await expect(gateway.deleteProvider("provider-1")).rejects.toThrow(
      "正在运行的任务",
    );
  });

  it("defines KIMI K3 as the built-in default template", () => {
    const catalogTemplate = PROVIDER_TEMPLATES.find(
      (template) => template.id === "kimi-k3",
    );
    expect(catalogTemplate).toBeDefined();
    expect(KIMI_PROVIDER_TEMPLATE).toEqual({
      name: catalogTemplate!.name,
      kind: catalogTemplate!.kind,
      baseUrl: catalogTemplate!.baseUrl,
      modelId: catalogTemplate!.suggestedModelId,
      contextLength: catalogTemplate!.contextLength,
      headers: {},
    });
  });

  it.each<{ baseUrl: string; headers: Record<string, string>; contextLength: number }>([
    {
      baseUrl: "http://internal.example/v1",
      headers: {},
      contextLength: 128_000,
    },
    {
      baseUrl: "file:///tmp/model",
      headers: {},
      contextLength: 128_000,
    },
    {
      baseUrl: "https://api.example.com/v1",
      headers: { Cookie: "session=secret" },
      contextLength: 128_000,
    },
    {
      baseUrl: "https://api.example.com/v1",
      headers: {},
      contextLength: 1,
    },
  ])("revalidates provider security in the main-process gateway: %#", async (unsafe) => {
    const fetchImpl = vi.fn(
      async () => Response.json({ choices: [] }),
    ) as unknown as typeof fetch;
    const { gateway, repository } = await harness(fetchImpl);

    await expect(
      gateway.createProvider({
        id: "unsafe-provider",
        name: "不安全模型",
        kind: "openai-compatible",
        modelId: "unsafe",
        apiKey: "secret-value",
        isDefault: false,
        now: 100,
        ...unsafe,
      }),
    ).rejects.toThrow();
    expect(repository.get("unsafe-provider")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
