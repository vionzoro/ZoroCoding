import { ExportController } from "../../src/main/memory/exportController";
import { OutboxRepository } from "../../src/main/memory/outboxRepository";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerIpc,
  type IpcEventLike,
  type IpcMainLike,
  type IpcSenderLike,
  type RegisterIpcDependencies,
} from "../../src/main/ipc/registerIpc";
import { AgentRuntime } from "../../src/main/agent/agentRuntime";
import { ModelGateway } from "../../src/main/models/modelGateway";
import type { ModelEvent } from "../../src/main/models/types";
import { openDatabase } from "../../src/main/persistence/database";
import { ModelRoutingRepository } from "../../src/main/persistence/modelRoutingRepository";
import { ProviderRepository } from "../../src/main/persistence/providerRepository";
import { QuickChatRepository } from "../../src/main/persistence/quickChatRepository";
import { ModelRouter } from "../../src/main/routing/modelRouter";
import {
  SecretStore,
  type SecretCrypto,
} from "../../src/main/secrets/secretStore";
import { TaskRepository } from "../../src/main/persistence/taskRepository";
import type {
  QuickChatMessage,
  ProviderSnapshot,
  TaskEvent,
  TaskSnapshot,
} from "../../src/shared/domain";
import type { TaskEventEnvelope } from "../../src/shared/ipc";
import type { QuickChatEvent } from "../../src/main/quick-chat/quickChatService";

type IpcListener = (event: IpcEventLike, input?: unknown) => void;

const ipcTestCrypto: SecretCrypto = {
  encryptString(value) {
    return Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xaa));
  },
  decryptString(value) {
    return Buffer.from(value.map((byte) => byte ^ 0xaa)).toString(
      "utf8",
    );
  },
};

class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: IpcEventLike, input?: unknown) => unknown>();
  listeners = new Map<string, Set<IpcListener>>();

  handle(
    channel: string,
    listener: (event: IpcEventLike, input?: unknown) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }

  on(
    channel: string,
    listener: IpcListener,
  ): void {
    const listeners = this.listeners.get(channel) ?? new Set<IpcListener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  removeListener(
    channel: string,
    listener: IpcListener,
  ): void {
    const listeners = this.listeners.get(channel);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(channel);
  }

  async invoke(channel: string, input?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`Missing handler ${channel}`);
    }
    return handler(fakeEvent(), input);
  }

  emit(channel: string, event: IpcEventLike, input?: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener(event, input);
    }
  }

  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

class FakeIpcSender implements IpcSenderLike {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  readonly destroyedListeners = new Set<() => void>();
  destroyed = false;

  constructor(readonly id: number) {}

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  once(_event: "destroyed", listener: () => void): void {
    this.destroyedListeners.add(listener);
  }

  removeListener(_event: "destroyed", listener: () => void): void {
    this.destroyedListeners.delete(listener);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    const listeners = [...this.destroyedListeners];
    this.destroyedListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }
}

function fakeEvent(overrides: Partial<IpcEventLike> = {}): IpcEventLike {
  return {
    sender: {
      id: 1,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: () => false,
    },
    ...overrides,
  };
}

describe("registerIpc", () => {
  let portableRoot: string;
  let projectsRoot: string;
  let expectedProjectsRoot: string;
  let projectPath: string;
  let database: ReturnType<typeof openDatabase>;
  let tasks: TaskRepository;
  let providers: ProviderRepository;
  let quickChat: QuickChatRepository;
  let routing: ModelRoutingRepository;
  let modelRouter: ModelRouter;
  let ipcMain: FakeIpcMain;
  let dependencies: RegisterIpcDependencies;
  let taskListener: ((task: TaskSnapshot, event?: TaskEvent) => void) | undefined;
  let quickChatListener: ((event: QuickChatEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const unsubscribeQuickChat = vi.fn();

  beforeEach(async () => {
    portableRoot = await mkdtemp(join(tmpdir(), "zorocoding-ipc-"));
    projectsRoot = join(portableRoot, "ZoroCodingData", "Projects");
    projectPath = join(projectsRoot, "demo");
    await mkdir(projectPath, { recursive: true });
    expectedProjectsRoot = await realpath(projectsRoot);
    database = openDatabase(":memory:");
    tasks = new TaskRepository(database);
    providers = new ProviderRepository(database);
    quickChat = new QuickChatRepository(database);
    routing = new ModelRoutingRepository(database);
    modelRouter = new ModelRouter(routing, {
      getProviderSnapshot(providerId): ProviderSnapshot | null {
        const provider = providers.get(providerId);
        return provider === null
          ? null
          : {
              providerId: provider.id,
              name: provider.name,
              kind: provider.kind,
              baseUrl: provider.baseUrl,
              modelId: provider.modelId,
              contextLength: provider.contextLength,
            };
      },
    });
    ipcMain = new FakeIpcMain();
    dependencies = {
      ipcMain,
      dialog: {
        showOpenDialog: vi.fn(async () => ({
          canceled: false,
          filePaths: [projectPath],
        })),
      },
      appInfo: {
        portable: true,
        volumeName: "ZoroCoding Test",
        dataRoot: join(portableRoot, "ZoroCodingData"),
        projectsRoot,
        storageAvailable: true,
        restartRequired: false,
      },
      tasks,
      providers,
      quickChat,
      quickChatService: {
        send: vi.fn<RegisterIpcDependencies["quickChatService"]["send"]>(async (input) => ({
          id: "assistant-1",
          sessionId: input.sessionId,
          role: "assistant",
          content: "回答",
          providerSnapshot: {
            providerId: "provider-1",
            name: "KIMI K3",
            kind: "kimi",
            baseUrl: "https://api.moonshot.cn/v1",
            modelId: "kimi-k3",
            contextLength: 1_000_000,
          },
          routeDecision: {
            intent: "simple_qa",
            lane: "premium",
            executionMode: "read_only",
            confidence: "high",
            reasonCode: "simple-question",
          },
          status: "completed",
          errorMessage: null,
          createdAt: 100,
        })),
        cancel: vi.fn(async () => {}),
        retry: vi.fn<RegisterIpcDependencies["quickChatService"]["retry"]>(async (input) => ({
          id: "assistant-retry",
          sessionId: input.sessionId,
          role: "assistant",
          content: "重试回答",
          providerSnapshot: null,
          routeDecision: null,
          status: "failed",
          errorMessage: "模型请求失败，请稍后重试。",
          createdAt: 100,
        })),
        subscribe: vi.fn((listener) => {
          quickChatListener = listener;
          return unsubscribeQuickChat;
        }),
      },
      routing,
      modelRouter,
      projectsRoot,
      expectedProjectsRoot,
      runtime: {
        createTask: vi.fn(async (input) => {
          const now = 100;
          tasks.upsertProject(input.project);
          const snapshot: TaskSnapshot = {
            id: "task-1",
            projectId: input.project.id,
            title: input.prompt,
            prompt: input.prompt,
            status: "draft",
            providerSnapshot: input.provider,
            routeDecision: input.routeDecision,
            selectionMode: input.selectionMode,
            executionMode: input.routeDecision.executionMode,
            progress: {
              percent: 0,
              elapsedSeconds: 0,
              remainingSeconds: null,
              estimationState: "recalculating",
            },
            currentStepId: null,
            activeSince: null,
            pausedSince: null,
            pauseReason: null,
            createdAt: now,
            updatedAt: now,
          };
          tasks.create(snapshot);
          return snapshot;
        }),
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        retry: vi.fn(async () => {}),
        addMessage: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        resolveApproval: vi.fn(async () => {}),
        subscribe: vi.fn((listener) => {
          taskListener = listener;
          return unsubscribe;
        }),
      },
      modelGateway: {
        getProviderSnapshot: vi.fn((providerId: string) => {
          const provider = providers.get(providerId);
          return provider === null
            ? null
            : {
                providerId: provider.id,
                name: provider.name,
                kind: provider.kind,
                baseUrl: provider.baseUrl,
                modelId: provider.modelId,
                contextLength: provider.contextLength,
              };
        }),
        createProvider: vi.fn(),
        updateProvider: vi.fn(),
        deleteProvider: vi.fn(),
        testDraft: vi.fn(async () => ({ ok: true as const, latencyMs: 12 })),
        discoverDraftModels: vi.fn(async () => [
          { id: "qwen-coder", label: "qwen-coder" },
        ]),
        testAndRecordProvider: vi.fn(async () => ({
          ok: true as const,
          latencyMs: 15,
        })),
      },
      now: () => 100,
      createId: () => "generated-id",
    };
  });

  afterEach(async () => {
    database.close();
    await rm(portableRoot, { recursive: true, force: true });
    unsubscribe.mockClear();
    unsubscribeQuickChat.mockClear();
  });

  it("keeps exports disabled and validates explicit consent requests at the IPC boundary", async () => {
    registerIpc(dependencies);
    await expect(ipcMain.invoke("zoro:memory-exports:destinations")).resolves.toEqual([]);
    await expect(ipcMain.invoke("zoro:memory-exports:list", { taskId: "task-1" })).resolves.toEqual([]);
    await expect(ipcMain.invoke("zoro:memory-exports:consent", { token: "missing", entry: {} })).rejects.toThrow("请求无效");
    await expect(ipcMain.invoke("zoro:memory-exports:consent", { token: "missing" })).rejects.toThrow("未配置");
  });

  it("blocks export consent, revocation and dispatch when storage is not writable", async () => {
    const memoryExports = new ExportController(new OutboxRepository(database));
    const consent = vi.spyOn(memoryExports, "consent");
    const revoke = vi.spyOn(memoryExports, "revoke");
    const flush = vi.spyOn(memoryExports, "flush");
    registerIpc({ ...dependencies, memoryExports, readOnly: true });
    await expect(ipcMain.invoke("zoro:memory-exports:consent", { token: "preview-token" })).rejects.toThrow("只读");
    await expect(ipcMain.invoke("zoro:memory-exports:revoke", { clientWriteId: "write-1" })).rejects.toThrow("只读");
    await expect(ipcMain.invoke("zoro:memory-exports:flush")).rejects.toThrow("只读");
    expect(consent).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("rejects a create-task request without an authorized project id", async () => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:tasks:create", {
        prompt: "Fix it",
        selection: { mode: "auto" },
      }),
    ).rejects.toThrow("Invalid create task request");
  });

  it("returns only non-secret portable application information", async () => {
    registerIpc({
      ...dependencies,
      appInfo: {
        portable: true,
        volumeName: "ORICO",
        dataRoot: "/Volumes/ORICO/ZoroCodingData",
        projectsRoot: "/Volumes/ORICO/ZoroCodingData/Projects",
        storageAvailable: true,
        restartRequired: false,
      },
    });

    await expect(ipcMain.invoke("zoro:app:info")).resolves.toEqual({
      portable: true,
      volumeName: "ORICO",
      dataRoot: "/Volumes/ORICO/ZoroCodingData",
      projectsRoot: "/Volumes/ORICO/ZoroCodingData/Projects",
      storageAvailable: true,
      restartRequired: false,
    });
  });

  it("delays application information only through the explicit E2E seam", async () => {
    vi.useFakeTimers();
    try {
      registerIpc({
        ...dependencies,
        e2eAppInfoDelayMs: 250,
      });

      let settled = false;
      const pending = ipcMain
        .invoke("zoro:app:info")
        .then((value) => {
          settled = true;
          return value;
        });

      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        portable: true,
        storageAvailable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("authorizes and canonicalizes a project only through the folder picker", async () => {
    registerIpc(dependencies);

    const selected = await ipcMain.invoke("zoro:projects:select");

    expect(selected).toMatchObject({
      id: "generated-id",
      canonicalPath: await realpath(projectPath),
    });
    expect(dependencies.dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory"],
      defaultPath: projectsRoot,
    });
    expect(tasks.listProjects()).toEqual([selected]);
  });

  it("rejects a folder picker selection outside the portable Projects directory", async () => {
    const outsideProject = join(portableRoot, "outside-project");
    await mkdir(outsideProject);
    dependencies.dialog.showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: [outsideProject],
    }));
    registerIpc(dependencies);

    await expect(ipcMain.invoke("zoro:projects:select")).rejects.toThrow(
      "Projects",
    );
    expect(tasks.listProjects()).toEqual([]);
  });

  it("rejects a folder picker selection after Projects is replaced with an escape symlink", async () => {
    const outsideProject = join(portableRoot, "outside-project");
    await mkdir(outsideProject);
    await rm(projectsRoot, { recursive: true });
    await symlink(outsideProject, projectsRoot);
    dependencies.dialog.showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: [projectsRoot],
    }));
    registerIpc(dependencies);

    await expect(ipcMain.invoke("zoro:projects:select")).rejects.toThrow(
      "Projects",
    );
    expect(tasks.listProjects()).toEqual([]);
  });

  it("rejects a persisted project outside the portable Projects directory before task creation", async () => {
    const outsideProject = await mkdtemp(join(tmpdir(), "zorocoding-outside-"));
    tasks.upsertProject({
      id: "outside-project",
      name: "outside",
      canonicalPath: outsideProject,
      lastOpenedAt: 100,
    });
    providers.create({
      id: "provider-1",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "1234",
      isDefault: true,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "付费模型",
      dashboardUrl: "https://platform.kimi.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    registerIpc(dependencies);

    try {
      await expect(
        ipcMain.invoke("zoro:tasks:create", {
          projectId: "outside-project",
          prompt: "修改代码",
          selection: { mode: "manual", providerId: "provider-1" },
        }),
      ).rejects.toThrow("Projects");
      expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
    } finally {
      await rm(outsideProject, { recursive: true, force: true });
    }
  });

  it("revalidates a selected project after its path is replaced with an escape symlink", async () => {
    const outsideProject = await mkdtemp(join(tmpdir(), "zorocoding-outside-"));
    tasks.upsertProject({
      id: "project-1",
      name: "demo",
      canonicalPath: await realpath(projectPath),
      lastOpenedAt: 100,
    });
    providers.create({
      id: "provider-1",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "1234",
      isDefault: true,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "付费模型",
      dashboardUrl: "https://platform.kimi.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    await rm(projectPath, { recursive: true });
    await symlink(outsideProject, projectPath);
    registerIpc(dependencies);

    try {
      await expect(
        ipcMain.invoke("zoro:tasks:create", {
          projectId: "project-1",
          prompt: "修改代码",
          selection: { mode: "manual", providerId: "provider-1" },
        }),
      ).rejects.toThrow("Projects");
      expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
    } finally {
      await rm(outsideProject, { recursive: true, force: true });
    }
  });

  it("rejects a persisted project after Projects is replaced with an escape symlink", async () => {
    const outsideProject = join(portableRoot, "outside-project");
    tasks.upsertProject({
      id: "project-1",
      name: "Projects",
      canonicalPath: expectedProjectsRoot,
      lastOpenedAt: 100,
    });
    providers.create({
      id: "provider-1",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "1234",
      isDefault: true,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "付费模型",
      dashboardUrl: "https://platform.kimi.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    await mkdir(outsideProject);
    await rm(projectsRoot, { recursive: true });
    await symlink(outsideProject, projectsRoot);
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:tasks:create", {
        projectId: "project-1",
        prompt: "修改代码",
        selection: { mode: "manual", providerId: "provider-1" },
      }),
    ).rejects.toThrow("Projects");
    expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
  });

  it("routes a validated task request using persisted project and provider data", async () => {
    tasks.upsertProject({
      id: "project-1",
      name: "demo",
      canonicalPath: await realpath(projectPath),
      lastOpenedAt: 100,
    });
    providers.create({
      id: "provider-1",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "1234",
      isDefault: true,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "付费模型",
      dashboardUrl: "https://platform.kimi.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    routing.update(
      {
        lightProviderId: "provider-1",
        premiumProviderId: "provider-1",
      },
      100,
    );
    registerIpc(dependencies);

    const detail = await ipcMain.invoke("zoro:tasks:create", {
      projectId: "project-1",
      prompt: "修复登录状态恢复",
      selection: { mode: "auto" },
    });

    expect(dependencies.runtime.createTask).toHaveBeenCalledWith(
      {
        project: expect.objectContaining({
          id: "project-1",
          canonicalPath: await realpath(projectPath),
        }),
        prompt: "修复登录状态恢复",
        provider: {
          providerId: "provider-1",
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
          confidence: "high",
          reasonCode: "project-change",
        },
        selectionMode: "auto",
      },
    );
    expect(detail).toMatchObject({
      task: {
        id: "task-1",
        selectionMode: "auto",
        routeDecision: {
          lane: "premium",
          executionMode: "agentic",
        },
      },
      project: { id: "project-1" },
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /secretRef|apiKey|keySuffix|headers/i,
    );
  });

  it("requires providerId only for manual task selection", async () => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:tasks:create", {
        projectId: "project-1",
        prompt: "解释这段代码",
        selection: { mode: "manual" },
      }),
    ).rejects.toThrow("Invalid create task request");
    expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["routeDecision", { lane: "light" }],
    ["executionMode", "read_only"],
    ["projectPath", "/tmp/renderer-controlled"],
    ["tools", ["write_file"]],
    ["extra", true],
  ])(
    "rejects renderer-supplied create-task field %s",
    async (key, value) => {
      tasks.upsertProject({
        id: "project-1",
        name: "demo",
        canonicalPath: await realpath(projectPath),
        lastOpenedAt: 100,
      });
      registerIpc(dependencies);

      await expect(
        ipcMain.invoke("zoro:tasks:create", {
          projectId: "project-1",
          prompt: "解释这段代码",
          selection: { mode: "manual", providerId: "provider-1" },
          [key]: value,
        }),
      ).rejects.toThrow("Invalid create task request");
      expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
    },
  );

  it("strictly rejects extra fields inside automatic model selection", async () => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:tasks:create", {
        projectId: "project-1",
        prompt: "解释这段代码",
        selection: { mode: "auto", providerId: "renderer-choice" },
      }),
    ).rejects.toThrow("Invalid create task request");
    expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
  });

  it("previews the same local route without creating a task or calling a model", async () => {
    providers.create({
      id: "groq",
      name: "Groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      modelId: "llama-3.1-8b-instant",
      contextLength: 128_000,
      headers: {},
      secretRef: "provider/groq",
      keySuffix: "1234",
      isDefault: false,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "快速模型",
      dashboardUrl: "https://console.groq.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    routing.update(
      { lightProviderId: "groq", premiumProviderId: "groq" },
      100,
    );
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:routing:preview", {
        prompt: "翻译成英文",
        selection: { mode: "auto" },
      }),
    ).resolves.toEqual({
      decision: {
        intent: "simple_text",
        lane: "light",
        executionMode: "read_only",
        confidence: "high",
        reasonCode: "text-transform",
      },
      selectionMode: "auto",
      provider: {
        providerId: "groq",
        name: "Groq",
        kind: "openai-compatible",
        baseUrl: "https://api.groq.com/openai/v1",
        modelId: "llama-3.1-8b-instant",
        contextLength: 128_000,
      },
    });
    expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
    expect(dependencies.modelGateway.testDraft).not.toHaveBeenCalled();
    expect(
      dependencies.modelGateway.testAndRecordProvider,
    ).not.toHaveBeenCalled();
  });

  it("rejects a routing preview result containing provider configuration fields", async () => {
    dependencies.modelRouter = {
      resolve: vi.fn<RegisterIpcDependencies["modelRouter"]["resolve"]>(() => ({
        decision: {
          intent: "simple_qa",
          lane: "light",
          executionMode: "read_only",
          confidence: "high",
          reasonCode: "simple-question",
        },
        selectionMode: "auto",
        provider: {
          providerId: "provider-1",
          name: "Provider",
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "model-1",
          contextLength: 128_000,
          headers: { Authorization: "Bearer secret" },
          secretRef: "provider/provider-1",
          keySuffix: "1234",
          connectionStatus: "connected",
        },
      })),
    };
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:routing:preview", {
        prompt: "hello",
        selection: { mode: "auto" },
      }),
    ).rejects.toThrow();
  });

  it("preflights both routing update providers before the routing repository", async () => {
    const provider: ProviderSnapshot = {
      providerId: "light-1",
      name: "Light",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "light-model",
      contextLength: 128_000,
    };
    const getProviderSnapshot = vi.fn((providerId: string) =>
      providerId === provider.providerId ? provider : null,
    );
    const update = vi.fn(() => ({
      lightProviderId: "light-1",
      premiumProviderId: "missing-premium",
      updatedAt: 100,
    }));
    dependencies.modelGateway = {
      ...dependencies.modelGateway,
      getProviderSnapshot,
    };
    dependencies.routing = {
      get: vi.fn(() => null),
      update,
    };
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:routing:update", {
        lightProviderId: "light-1",
        premiumProviderId: "missing-premium",
      }),
    ).rejects.toThrow("不存在");

    expect(getProviderSnapshot.mock.calls).toEqual([
      ["light-1"],
      ["missing-premium"],
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("preflights only manual routing previews before the resolver", async () => {
    const resolve = vi.fn(() => ({
      decision: {
        intent: "simple_qa" as const,
        lane: "light" as const,
        executionMode: "read_only" as const,
        confidence: "high" as const,
        reasonCode: "simple-question" as const,
      },
      selectionMode: "auto" as const,
      provider: {
        providerId: "auto-provider",
        name: "Auto Provider",
        kind: "openai-compatible" as const,
        baseUrl: "https://api.example.com/v1",
        modelId: "auto-model",
        contextLength: 128_000,
      },
    }));
    const getProviderSnapshot = vi.fn(() => null);
    dependencies.modelRouter = { resolve };
    dependencies.modelGateway = {
      ...dependencies.modelGateway,
      getProviderSnapshot,
    };
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:routing:preview", {
        prompt: "hello",
        selection: {
          mode: "manual",
          providerId: "missing-provider",
        },
      }),
    ).rejects.toThrow("不存在");
    expect(resolve).not.toHaveBeenCalled();
    expect(getProviderSnapshot).toHaveBeenCalledWith("missing-provider");

    getProviderSnapshot.mockClear();
    await expect(
      ipcMain.invoke("zoro:routing:preview", {
        prompt: "hello",
        selection: { mode: "auto" },
      }),
    ).resolves.toMatchObject({ selectionMode: "auto" });
    expect(getProviderSnapshot).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("gets and updates routing roles while rejecting missing providers", async () => {
    providers.create({
      id: "provider-1",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "1234",
      isDefault: true,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "付费模型",
      dashboardUrl: "https://platform.kimi.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    routing.bootstrap(providers.list(), 90);
    registerIpc(dependencies);

    await expect(ipcMain.invoke("zoro:routing:get")).resolves.toEqual({
      lightProviderId: null,
      premiumProviderId: "provider-1",
      updatedAt: 90,
    });
    await expect(
      ipcMain.invoke("zoro:routing:update", {
        lightProviderId: "provider-1",
        premiumProviderId: "provider-1",
      }),
    ).resolves.toEqual({
      lightProviderId: "provider-1",
      premiumProviderId: "provider-1",
      updatedAt: 100,
    });
    await expect(
      ipcMain.invoke("zoro:routing:update", {
        lightProviderId: "missing",
        premiumProviderId: "provider-1",
      }),
    ).rejects.toThrow("Provider missing does not exist");
  });

  it("requires changing a routing role before deleting its provider", async () => {
    routing.bootstrap([], 90);
    providers.create({
      id: "provider-1",
      name: "Groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      modelId: "llama-3.1-8b-instant",
      contextLength: 128_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "1234",
      isDefault: false,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "快速模型",
      dashboardUrl: "https://console.groq.com/",
      createdAt: 100,
      updatedAt: 100,
    });
    routing.update(
      { lightProviderId: "provider-1", premiumProviderId: null },
      100,
    );
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:providers:remove", { id: "provider-1" }),
    ).rejects.toThrow("先更换路由模型");
    expect(dependencies.modelGateway.deleteProvider).not.toHaveBeenCalled();
  });

  it("validates provider tests without exposing a stored secret", async () => {
    registerIpc(dependencies);

    const result = await ipcMain.invoke("zoro:providers:test", {
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      apiKey: "secret-value",
      isDefault: false,
    });

    expect(result).toEqual({ ok: true, latencyMs: 12 });
    expect(dependencies.modelGateway.testDraft).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "secret-value" }),
    );
  });

  it("returns a complete non-secret provider template catalog", async () => {
    registerIpc(dependencies);

    const first = (await ipcMain.invoke(
      "zoro:providers:templates",
    )) as Array<{ id: string; name: string }>;
    expect(first.map((item) => item.id)).toEqual([
      "kimi-k3",
      "groq",
      "gemini",
      "openrouter",
      "cerebras",
      "sambanova",
      "mistral",
      "nvidia",
      "zhipu",
      "ollama",
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /("apiKey"|gsk_|sk-or-|csk-|nvapi-)/i,
    );

    first[0].name = "mutated";
    await expect(
      ipcMain.invoke("zoro:providers:templates"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "kimi-k3", name: "KIMI K3" }),
      ]),
    );
  });

  it("strictly validates and routes provider model discovery", async () => {
    registerIpc(dependencies);
    const input = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-discovery-key",
      headers: {},
    };

    await expect(
      ipcMain.invoke("zoro:providers:discover-models", input),
    ).resolves.toEqual([{ id: "qwen-coder", label: "qwen-coder" }]);
    expect(
      dependencies.modelGateway.discoverDraftModels,
    ).toHaveBeenCalledWith(input);

    await expect(
      ipcMain.invoke("zoro:providers:discover-models", {
        ...input,
        unexpected: true,
      }),
    ).rejects.toThrow("Invalid provider model discovery request");
    await expect(
      ipcMain.invoke("zoro:providers:discover-models", {
        ...input,
        apiKey: "   ",
      }),
    ).rejects.toThrow("Invalid provider model discovery request");
    await expect(
      ipcMain.invoke("zoro:providers:discover-models", {
        ...input,
        baseUrl: "http://remote.example.com/v1",
      }),
    ).rejects.toThrow("HTTPS");
  });

  it.each([
    {
      state: "storage is unavailable",
      configure: () => {
        dependencies.appInfo.storageAvailable = false;
      },
      expectedMessage: "移动硬盘已断开",
    },
    {
      state: "storage requires a restart",
      configure: () => {
        dependencies.storageRestartRequired = () => true;
      },
      expectedMessage: "请重启 ZoroCoding",
    },
  ])(
    "rejects draft provider network calls before parsing when $state",
    async ({ configure, expectedMessage }) => {
      configure();
      registerIpc(dependencies);

      await expect(
        ipcMain.invoke("zoro:providers:test", null),
      ).rejects.toThrow(expectedMessage);
      await expect(
        ipcMain.invoke("zoro:providers:discover-models", null),
      ).rejects.toThrow(expectedMessage);

      expect(dependencies.modelGateway.testDraft).not.toHaveBeenCalled();
      expect(
        dependencies.modelGateway.discoverDraftModels,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects a protected provider save through IPC before discovery", async () => {
    dependencies.modelGateway = new ModelGateway(
      providers,
      new SecretStore(join(portableRoot, "secrets"), ipcTestCrypto),
      (async () =>
        Response.json({ data: [{ id: "protected-model" }] })) as typeof fetch,
    );
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:providers:create", {
        name: "Cerebras",
        kind: "openai-compatible",
        baseUrl: "https://api.cerebras.ai/v1",
        modelId: "protected-model",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-ipc-protected-key",
        isDefault: false,
      }),
    ).rejects.toThrow("发现");
    expect(providers.list()).toEqual([]);
  });

  it("allows protected discovery then save through the same IPC gateway", async () => {
    dependencies.modelGateway = new ModelGateway(
      providers,
      new SecretStore(join(portableRoot, "secrets"), ipcTestCrypto),
      (async () =>
        Response.json({ data: [{ id: "protected-model" }] })) as typeof fetch,
      () => false,
      () => "ipc-protected-version",
    );
    registerIpc(dependencies);
    const discovery = {
      baseUrl: "https://api.cerebras.ai/v1/",
      apiKey: "test-ipc-protected-key",
      headers: {},
    };

    await expect(
      ipcMain.invoke("zoro:providers:discover-models", discovery),
    ).resolves.toEqual([
      { id: "protected-model", label: "protected-model" },
    ]);
    await expect(
      ipcMain.invoke("zoro:providers:create", {
        name: "Cerebras",
        kind: "openai-compatible",
        baseUrl: "https://api.cerebras.ai/v1",
        modelId: "protected-model",
        contextLength: 128_000,
        headers: {},
        apiKey: "test-ipc-protected-key",
        isDefault: false,
      }),
    ).resolves.toMatchObject({
      id: "generated-id",
      modelId: "protected-model",
    });
  });

  it("tests and records a saved provider through a write-gated IPC", async () => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:providers:test-saved", { id: "provider-1" }),
    ).resolves.toEqual({ ok: true, latencyMs: 15 });
    expect(
      dependencies.modelGateway.testAndRecordProvider,
    ).toHaveBeenCalledWith("provider-1");

    dependencies.appInfo.storageAvailable = false;
    await expect(
      ipcMain.invoke("zoro:providers:test-saved", { id: "provider-1" }),
    ).rejects.toThrow("移动硬盘已断开");
  });

  it.each([
    {
      baseUrl: "http://169.254.169.254/v1",
      contextLength: 128_000,
      headers: {},
    },
    {
      baseUrl: "https://api.example.com/v1",
      contextLength: 16,
      headers: {},
    },
    {
      baseUrl: "https://api.example.com/v1",
      contextLength: 128_000,
      headers: { Authorization: "attacker-controlled" },
    },
    {
      baseUrl: "https://api.example.com/v1",
      contextLength: 128_000,
      headers: { "X-Team": "one", "x-team": "two" },
    },
  ])("rejects unsafe provider input in IPC: %#", async (unsafe) => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:providers:test", {
        name: "不安全模型",
        kind: "openai-compatible",
        modelId: "unsafe",
        apiKey: "secret-value",
        isDefault: false,
        ...unsafe,
      }),
    ).rejects.toThrow("Invalid provider test request");
    expect(dependencies.modelGateway.testDraft).not.toHaveBeenCalled();
  });

  it("strictly rejects renderer-controlled capabilities from Quick Chat send and retry", async () => {
    quickChat.createSession({
      id: "session-1",
      title: "新对话",
      createdAt: 1,
      updatedAt: 1,
    });
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:quick-chat:send", {
        sessionId: "session-1",
        prompt: "hello",
        selection: { mode: "auto" },
        projectId: "forbidden",
        projectPath: "/tmp",
        command: "pwd",
        tools: [],
      }),
    ).rejects.toThrow("Invalid Quick Chat send request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:retry", {
        sessionId: "session-1",
        messageId: "message-1",
        prompt: "hello",
        selection: { mode: "auto" },
        projectId: "forbidden",
        projectPath: "/tmp",
        command: "pwd",
        tools: [],
      }),
    ).rejects.toThrow("Invalid Quick Chat retry request");

    expect(dependencies.quickChatService.send).not.toHaveBeenCalled();
    expect(dependencies.quickChatService.retry).not.toHaveBeenCalled();
  });

  it("trims bounded Quick Chat prompts and rejects invalid manual providers before model work", async () => {
    quickChat.createSession({
      id: "session-1",
      title: "新对话",
      createdAt: 1,
      updatedAt: 1,
    });
    registerIpc(dependencies);

    await ipcMain.invoke("zoro:quick-chat:send", {
      sessionId: "session-1",
      prompt: "  hello  ",
      selection: { mode: "auto" },
    });

    expect(dependencies.quickChatService.send).toHaveBeenCalledWith({
      sessionId: "session-1",
      prompt: "hello",
      selection: { mode: "auto" },
    });

    await expect(
      ipcMain.invoke("zoro:quick-chat:send", {
        sessionId: "session-1",
        prompt: "x".repeat(100_001),
        selection: { mode: "auto" },
      }),
    ).rejects.toThrow("Invalid Quick Chat send request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:send", {
        sessionId: "session-1",
        prompt: "hello",
        selection: { mode: "manual", providerId: "missing-provider" },
      }),
    ).rejects.toThrow("不存在");
    await expect(
      ipcMain.invoke("zoro:quick-chat:retry", {
        sessionId: "session-1",
        messageId: "message-1",
        selection: { mode: "manual", providerId: "missing-provider" },
      }),
    ).rejects.toThrow("不存在");

    expect(dependencies.quickChatService.send).toHaveBeenCalledOnce();
    expect(dependencies.quickChatService.retry).not.toHaveBeenCalled();
  });

  it("creates, renames, lists, and deletes Quick Chat sessions through owned repository records", async () => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:quick-chat:create-session"),
    ).resolves.toEqual({
      id: "generated-id",
      title: "新对话",
      createdAt: 100,
      updatedAt: 100,
    });
    await expect(
      ipcMain.invoke("zoro:quick-chat:rename-session", {
        sessionId: "generated-id",
        title: "  新标题  ",
      }),
    ).resolves.toEqual({
      id: "generated-id",
      title: "新标题",
      createdAt: 100,
      updatedAt: 100,
    });
    await expect(
      ipcMain.invoke("zoro:quick-chat:list-sessions"),
    ).resolves.toEqual([
      {
        id: "generated-id",
        title: "新标题",
        createdAt: 100,
        updatedAt: 100,
      },
    ]);
    await expect(
      ipcMain.invoke("zoro:quick-chat:list-messages", {
        sessionId: "generated-id",
      }),
    ).resolves.toEqual([]);
    await expect(
      ipcMain.invoke("zoro:quick-chat:delete-session", {
        sessionId: "generated-id",
      }),
    ).resolves.toBeUndefined();

    expect(dependencies.quickChatService.cancel).toHaveBeenCalledWith(
      "generated-id",
    );
    expect(quickChat.getSession("generated-id")).toBeNull();
  });

  it("rejects missing Quick Chat sessions before repository or service side effects", async () => {
    registerIpc(dependencies);

    for (const [channel, input] of [
      [
        "zoro:quick-chat:rename-session",
        { sessionId: "missing", title: "title" },
      ],
      ["zoro:quick-chat:delete-session", { sessionId: "missing" }],
      ["zoro:quick-chat:list-messages", { sessionId: "missing" }],
      [
        "zoro:quick-chat:send",
        {
          sessionId: "missing",
          prompt: "hello",
          selection: { mode: "auto" },
        },
      ],
      ["zoro:quick-chat:cancel", { sessionId: "missing" }],
      [
        "zoro:quick-chat:retry",
        {
          sessionId: "missing",
          messageId: "message-1",
          selection: { mode: "auto" },
        },
      ],
    ] as const) {
      await expect(ipcMain.invoke(channel, input)).rejects.toThrow("不存在");
    }

    expect(dependencies.quickChatService.send).not.toHaveBeenCalled();
    expect(dependencies.quickChatService.cancel).not.toHaveBeenCalled();
    expect(dependencies.quickChatService.retry).not.toHaveBeenCalled();
  });

  it("strictly validates empty routing and Quick Chat endpoints", async () => {
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:routing:get", { extra: true }),
    ).rejects.toThrow("Invalid routing get request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:list-sessions", { extra: true }),
    ).rejects.toThrow("Invalid Quick Chat list sessions request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:create-session", { extra: true }),
    ).rejects.toThrow("Invalid Quick Chat create session request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:rename-session", {
        sessionId: "session-1",
        title: "x".repeat(101),
      }),
    ).rejects.toThrow("Invalid Quick Chat rename session request");
  });

  it("accepts omitted empty-endpoint payloads but rejects explicit null", async () => {
    routing.bootstrap([], 90);
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:routing:get"),
    ).resolves.toMatchObject({ updatedAt: 90 });
    await expect(
      ipcMain.invoke("zoro:quick-chat:list-sessions"),
    ).resolves.toEqual([]);
    await expect(
      ipcMain.invoke("zoro:quick-chat:create-session"),
    ).resolves.toMatchObject({ id: "generated-id" });

    await expect(
      ipcMain.invoke("zoro:routing:get", null),
    ).rejects.toThrow("Invalid routing get request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:list-sessions", null),
    ).rejects.toThrow("Invalid Quick Chat list sessions request");
    await expect(
      ipcMain.invoke("zoro:quick-chat:create-session", null),
    ).rejects.toThrow("Invalid Quick Chat create session request");
    expect(quickChat.listSessions()).toHaveLength(1);
  });

  it("rejects Quick Chat mutations before side effects when storage is unavailable or read-only", async () => {
    dependencies.appInfo.storageAvailable = false;
    registerIpc(dependencies);

    for (const [channel, input] of [
      ["zoro:quick-chat:create-session", undefined],
      [
        "zoro:quick-chat:rename-session",
        { sessionId: "session-1", title: "title" },
      ],
      ["zoro:quick-chat:delete-session", { sessionId: "session-1" }],
      [
        "zoro:quick-chat:send",
        {
          sessionId: "session-1",
          prompt: "hello",
          selection: { mode: "auto" },
        },
      ],
      ["zoro:quick-chat:cancel", { sessionId: "session-1" }],
      [
        "zoro:quick-chat:retry",
        {
          sessionId: "session-1",
          messageId: "message-1",
          selection: { mode: "auto" },
        },
      ],
    ] as const) {
      await expect(ipcMain.invoke(channel, input)).rejects.toThrow(
        "移动硬盘已断开",
      );
    }
    expect(quickChat.listSessions()).toEqual([]);
    expect(dependencies.quickChatService.send).not.toHaveBeenCalled();
    expect(dependencies.quickChatService.cancel).not.toHaveBeenCalled();
    expect(dependencies.quickChatService.retry).not.toHaveBeenCalled();

    dependencies.appInfo.storageAvailable = true;
    dependencies.readOnly = true;
    registerIpc(dependencies);
    await expect(
      ipcMain.invoke("zoro:quick-chat:create-session"),
    ).rejects.toThrow("只读恢复模式");
    expect(quickChat.listSessions()).toEqual([]);
  });

  it("forwards only strict secret-free Quick Chat events for the matching subscription", () => {
    registerIpc(dependencies);
    const send = vi.fn();
    const event = fakeEvent({
      sender: {
        id: 7,
        send,
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
      },
    });

    ipcMain.emit("zoro:quick-chat:subscribe", event, {
      subscriptionId: "subscription-1",
    });
    quickChatListener?.({
      type: "message_completed",
      message: {
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        content: "回答",
        providerSnapshot: {
          providerId: "provider-1",
          name: "Provider",
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "model-1",
          contextLength: 128_000,
        },
        routeDecision: null,
        status: "completed",
        errorMessage: null,
        createdAt: 2,
      },
    });
    quickChatListener?.({
      type: "message_completed",
      message: {
        id: "message-unsafe",
        sessionId: "session-1",
        role: "assistant",
        content: "unsafe",
        providerSnapshot: {
          providerId: "provider-1",
          name: "Provider",
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "model-1",
          contextLength: 128_000,
          secretRef: "provider/provider-1",
        },
        routeDecision: null,
        status: "completed",
        errorMessage: null,
        createdAt: 3,
      },
    } as QuickChatEvent);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("zoro:quick-chat:event", {
      subscriptionId: "subscription-1",
      event: expect.objectContaining({
        type: "message_completed",
        message: expect.objectContaining({ id: "message-1" }),
      }),
    });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(
      /secretRef|apiKey|keySuffix|headers|projectPath/i,
    );
  });

  it("replaces duplicate Quick Chat subscription IDs and unregisters listener channels", () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    vi.mocked(dependencies.quickChatService.subscribe)
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);
    const unregister = registerIpc(dependencies);
    const event = fakeEvent({
      sender: {
        id: 9,
        send: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
      },
    });

    ipcMain.emit("zoro:quick-chat:subscribe", event, {
      subscriptionId: "same-id",
    });
    ipcMain.emit("zoro:quick-chat:subscribe", event, {
      subscriptionId: "same-id",
    });
    ipcMain.emit("zoro:quick-chat:subscribe", event, {
      subscriptionId: "same-id",
      extra: true,
    });

    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondUnsubscribe).not.toHaveBeenCalled();
    expect(dependencies.quickChatService.subscribe).toHaveBeenCalledTimes(2);
    expect(ipcMain.listenerCount("zoro:quick-chat:subscribe")).toBe(1);
    expect(ipcMain.listenerCount("zoro:quick-chat:unsubscribe")).toBe(1);

    unregister();

    expect(secondUnsubscribe).toHaveBeenCalledOnce();
    expect(ipcMain.listenerCount("zoro:quick-chat:subscribe")).toBe(0);
    expect(ipcMain.listenerCount("zoro:quick-chat:unsubscribe")).toBe(0);
  });

  it("unsubscribes only the matching Quick Chat sender and subscription ID", () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const otherSenderUnsubscribe = vi.fn();
    vi.mocked(dependencies.quickChatService.subscribe)
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe)
      .mockReturnValueOnce(otherSenderUnsubscribe);
    const unregister = registerIpc(dependencies);
    const firstSender = fakeEvent({
      sender: {
        id: 10,
        send: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
      },
    });
    const otherSender = fakeEvent({
      sender: {
        id: 11,
        send: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
      },
    });
    ipcMain.emit("zoro:quick-chat:subscribe", firstSender, {
      subscriptionId: "first",
    });
    ipcMain.emit("zoro:quick-chat:subscribe", firstSender, {
      subscriptionId: "second",
    });
    ipcMain.emit("zoro:quick-chat:subscribe", otherSender, {
      subscriptionId: "first",
    });

    ipcMain.emit("zoro:quick-chat:unsubscribe", firstSender, {
      subscriptionId: "first",
    });

    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondUnsubscribe).not.toHaveBeenCalled();
    expect(otherSenderUnsubscribe).not.toHaveBeenCalled();

    unregister();
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondUnsubscribe).toHaveBeenCalledOnce();
    expect(otherSenderUnsubscribe).toHaveBeenCalledOnce();
  });

  it("uses one destroyed hook for coexisting task and Quick Chat subscriptions", () => {
    const sender = new FakeIpcSender(12);
    const taskUnsubscribe = vi.fn();
    let reentered = false;
    const quickUnsubscribe = vi.fn(() => {
      if (!reentered) {
        reentered = true;
        ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
          subscriptionId: "reentrant",
        });
      }
      throw new Error("unsubscribe failure");
    });
    vi.mocked(dependencies.runtime.subscribe).mockReturnValue(taskUnsubscribe);
    vi.mocked(dependencies.quickChatService.subscribe).mockReturnValue(
      quickUnsubscribe,
    );
    registerIpc(dependencies);
    ipcMain.emit("zoro:tasks:subscribe", { sender }, "task-subscription");
    ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
      subscriptionId: "quick-subscription",
    });

    expect(sender.destroyedListeners.size).toBe(1);
    expect(() => sender.destroy()).not.toThrow();

    expect(taskUnsubscribe).toHaveBeenCalledOnce();
    expect(quickUnsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.quickChatService.subscribe).toHaveBeenCalledOnce();
    expect(sender.destroyedListeners.size).toBe(0);
  });

  it("does not accumulate destroyed hooks across repeated subscribe and unsubscribe cycles", () => {
    const sender = new FakeIpcSender(13);
    const callbacks: Array<ReturnType<typeof vi.fn>> = [];
    vi.mocked(dependencies.quickChatService.subscribe).mockImplementation(() => {
      const callback = vi.fn();
      callbacks.push(callback);
      return callback;
    });
    registerIpc(dependencies);

    for (let index = 0; index < 3; index += 1) {
      const subscriptionId = `cycle-${index}`;
      ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
        subscriptionId,
      });
      expect(sender.destroyedListeners.size).toBe(1);

      ipcMain.emit("zoro:quick-chat:unsubscribe", { sender }, {
        subscriptionId,
      });
      expect(sender.destroyedListeners.size).toBe(0);
    }

    expect(callbacks).toHaveLength(3);
    for (const callback of callbacks) {
      expect(callback).toHaveBeenCalledOnce();
    }
  });

  it("detaches explicit unsubscribe state before a throwing reentrant callback", () => {
    const sender = new FakeIpcSender(14);
    const hookCounts: number[] = [];
    let reentered = false;
    const firstUnsubscribe = vi.fn(() => {
      hookCounts.push(sender.destroyedListeners.size);
      if (!reentered) {
        reentered = true;
        ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
          subscriptionId: "reentrant",
        });
      }
      throw new Error("unsubscribe failure");
    });
    vi.mocked(dependencies.quickChatService.subscribe)
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(vi.fn());
    registerIpc(dependencies);
    ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
      subscriptionId: "first",
    });

    expect(() => {
      ipcMain.emit("zoro:quick-chat:unsubscribe", { sender }, {
        subscriptionId: "first",
      });
    }).not.toThrow();

    expect(hookCounts).toEqual([0]);
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.quickChatService.subscribe).toHaveBeenCalledOnce();
    expect(sender.destroyedListeners.size).toBe(0);
  });

  it("detaches duplicate state before a throwing reentrant replacement callback", () => {
    const sender = new FakeIpcSender(15);
    const hookCounts: number[] = [];
    let reentered = false;
    const firstUnsubscribe = vi.fn(() => {
      hookCounts.push(sender.destroyedListeners.size);
      if (!reentered) {
        reentered = true;
        ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
          subscriptionId: "reentrant",
        });
      }
      throw new Error("duplicate unsubscribe failure");
    });
    const replacementUnsubscribe = vi.fn();
    vi.mocked(dependencies.quickChatService.subscribe)
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(replacementUnsubscribe)
      .mockReturnValueOnce(vi.fn());
    registerIpc(dependencies);
    ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
      subscriptionId: "same",
    });

    expect(() => {
      ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
        subscriptionId: "same",
      });
    }).not.toThrow();

    expect(hookCounts).toEqual([0]);
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.quickChatService.subscribe).toHaveBeenCalledTimes(2);
    expect(sender.destroyedListeners.size).toBe(1);

    ipcMain.emit("zoro:quick-chat:unsubscribe", { sender }, {
      subscriptionId: "same",
    });
    expect(replacementUnsubscribe).toHaveBeenCalledOnce();
    expect(sender.destroyedListeners.size).toBe(0);
  });

  it("detaches all unregister state before callbacks and continues after throws", () => {
    const sender = new FakeIpcSender(16);
    const observedHookCounts: number[] = [];
    const taskUnsubscribe = vi.fn(() => {
      observedHookCounts.push(sender.destroyedListeners.size);
    });
    let reentered = false;
    const throwingUnsubscribe = vi.fn(() => {
      observedHookCounts.push(sender.destroyedListeners.size);
      if (!reentered) {
        reentered = true;
        ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
          subscriptionId: "reentrant",
        });
      }
      throw new Error("global unsubscribe failure");
    });
    const finalUnsubscribe = vi.fn(() => {
      observedHookCounts.push(sender.destroyedListeners.size);
    });
    vi.mocked(dependencies.runtime.subscribe).mockReturnValue(taskUnsubscribe);
    vi.mocked(dependencies.quickChatService.subscribe)
      .mockReturnValueOnce(throwingUnsubscribe)
      .mockReturnValueOnce(finalUnsubscribe)
      .mockReturnValueOnce(vi.fn());
    const unregister = registerIpc(dependencies);
    ipcMain.emit("zoro:tasks:subscribe", { sender }, "task");
    ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
      subscriptionId: "first",
    });
    ipcMain.emit("zoro:quick-chat:subscribe", { sender }, {
      subscriptionId: "second",
    });

    expect(sender.destroyedListeners.size).toBe(1);
    expect(unregister).not.toThrow();

    expect(taskUnsubscribe).toHaveBeenCalledOnce();
    expect(throwingUnsubscribe).toHaveBeenCalledOnce();
    expect(finalUnsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.quickChatService.subscribe).toHaveBeenCalledTimes(2);
    expect(observedHookCounts).toEqual([0, 0, 0]);
    expect(sender.destroyedListeners.size).toBe(0);
  });

  it("rejects a Quick Chat service response containing provider secrets", async () => {
    quickChat.createSession({
      id: "session-1",
      title: "新对话",
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(dependencies.quickChatService.send).mockResolvedValueOnce({
      id: "assistant-unsafe",
      sessionId: "session-1",
      role: "assistant",
      content: "unsafe",
      providerSnapshot: {
        providerId: "provider-1",
        name: "Provider",
        kind: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "model-1",
        contextLength: 128_000,
        headers: { Authorization: "Bearer secret" },
      },
      routeDecision: null,
      status: "completed",
      errorMessage: null,
      createdAt: 2,
    } as QuickChatMessage);
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:quick-chat:send", {
        sessionId: "session-1",
        prompt: "hello",
        selection: { mode: "auto" },
      }),
    ).rejects.toThrow();
  });

  it("rejects a Quick Chat retry response containing provider secrets", async () => {
    quickChat.createSession({
      id: "session-1",
      title: "新对话",
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(dependencies.quickChatService.retry).mockResolvedValueOnce({
      id: "assistant-retry-unsafe",
      sessionId: "session-1",
      role: "assistant",
      content: "unsafe",
      providerSnapshot: {
        providerId: "provider-1",
        name: "Provider",
        kind: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "model-1",
        contextLength: 128_000,
        secretRef: "provider/provider-1",
      },
      routeDecision: null,
      status: "completed",
      errorMessage: null,
      createdAt: 2,
    } as QuickChatMessage);
    registerIpc(dependencies);

    await expect(
      ipcMain.invoke("zoro:quick-chat:retry", {
        sessionId: "session-1",
        messageId: "message-1",
        selection: { mode: "auto" },
      }),
    ).rejects.toThrow();
  });

  it("forwards task events and cleans up subscriptions", () => {
    registerIpc(dependencies);
    const send = vi.fn();
    const destroyed = vi.fn();
    const event = fakeEvent({
      sender: {
        id: 7,
        send,
        once: vi.fn((_name, listener) => destroyed.mockImplementation(listener)),
        removeListener: vi.fn(),
        isDestroyed: () => false,
      },
    });

    ipcMain.emit("zoro:tasks:subscribe", event, "subscription-1");
    const snapshot: TaskSnapshot = {
      id: "task-1",
      projectId: "project-1",
      title: "任务",
      prompt: "任务",
      status: "running",
      providerSnapshot: {
        providerId: "provider-1",
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
        percent: 20,
        elapsedSeconds: 10,
        remainingSeconds: 40,
        estimationState: "ready",
      },
      currentStepId: null,
      activeSince: 1,
      pausedSince: null,
      pauseReason: null,
      createdAt: 1,
      updatedAt: 2,
    };
    const updateEvent: TaskEvent = {
      id: "event-live",
      taskId: "task-1",
      type: "model_output",
      at: 2,
      payload: { text: "实时输出" },
    };
    taskListener?.(snapshot, updateEvent);

    expect(send).toHaveBeenCalledWith(
      "zoro:tasks:event",
      expect.objectContaining({
        subscriptionId: "subscription-1",
        task: expect.objectContaining({ id: "task-1" }),
        event: updateEvent,
      }),
    );
    destroyed();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ["run_shell", "s".repeat(200 * 1024)],
    ["read_file", "r".repeat(300 * 1024)],
  ] as const)(
    "keeps a subscribed task complete when %s returns a large valid result",
    async (name, content) => {
      const turns: ModelEvent[][] = [
        [
          {
            type: "text_delta",
            text: JSON.stringify({
              title: "Large result",
              steps: [
                {
                  title: "Inspect",
                  completionCriteria: "Done",
                  estimateSeconds: 5,
                },
              ],
            }),
          },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool_call",
            call: {
              id: `call-${name}`,
              name,
              arguments: JSON.stringify(
                name === "run_shell"
                  ? { command: "fixture" }
                  : { path: "fixture.txt" },
              ),
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "Done" },
          { type: "finish", reason: "stop" },
        ],
      ];
      const runtime = new AgentRuntime({
        repository: tasks,
        modelGateway: {
          async *stream() {
            const turn = turns.shift();
            if (turn === undefined) throw new Error("missing model turn");
            yield* turn;
          },
        },
        createTools: () => ({
          definitions: [],
          execute: async (call) => ({
            callId: call.id,
            name: call.name,
            ok: true,
            content,
          }),
          cancelAll: async () => {},
        }),
        sleep: async () => {},
      });
      dependencies.runtime = runtime;
      registerIpc(dependencies);
      const throwingSender = new FakeIpcSender(76);
      vi.spyOn(throwingSender, "send").mockImplementation(() => {
        throw new Error("renderer was destroyed during delivery");
      });
      ipcMain.emit(
        "zoro:tasks:subscribe",
        { sender: throwingSender },
        "throwing-renderer-subscription",
      );
      const sender = new FakeIpcSender(77);
      ipcMain.emit(
        "zoro:tasks:subscribe",
        { sender },
        "large-result-subscription",
      );

      const task = await runtime.createTask({
        project: {
          id: "project-large-result",
          name: "Large result",
          canonicalPath: projectPath,
          lastOpenedAt: 1,
        },
        prompt: "Inspect a large result",
        provider: {
          providerId: "provider-1",
          name: "Provider",
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "model-1",
          contextLength: 128_000,
        },
        routeDecision: {
          intent: "complex_code",
          lane: "premium",
          executionMode: "agentic",
          confidence: "high",
          reasonCode: "project-change",
        },
        selectionMode: "auto",
      });
      await runtime.waitForIdle();

      expect(
        tasks
          .events(task.id)
          .filter((event) => event.type === "task_failed"),
      ).toEqual([]);
      expect(tasks.get(task.id)?.status).toBe("completed");
      expect(
        sender.sent.some(
          ({ payload }) =>
            (payload as TaskEventEnvelope).event?.type ===
            "task_completed",
        ),
      ).toBe(true);
      const deliveredTool = sender.sent
        .map(({ payload }) => payload as TaskEventEnvelope)
        .find(({ event }) => event?.type === "tool_completed");
      expect(deliveredTool?.event?.type).toBe("tool_completed");
      if (deliveredTool?.event?.type === "tool_completed") {
        expect(deliveredTool.event.payload.content.length).toBeLessThanOrEqual(
          256 * 1024,
        );
      }
    },
  );

  it("validates and routes task retry and supplemental messages", async () => {
    registerIpc(dependencies);

    await ipcMain.invoke("zoro:tasks:retry", { taskId: "task-1" });
    await ipcMain.invoke("zoro:tasks:add-message", {
      taskId: "task-1",
      content: "  补充无障碍标签  ",
    });

    expect(dependencies.runtime.retry).toHaveBeenCalledWith("task-1");
    expect(dependencies.runtime.addMessage).toHaveBeenCalledWith(
      "task-1",
      "补充无障碍标签",
    );
    await expect(
      ipcMain.invoke("zoro:tasks:add-message", {
        taskId: "task-1",
        content: " ",
      }),
    ).rejects.toThrow("Invalid task message request");
  });

  it("rejects every state-changing IPC before side effects in read-only recovery mode", async () => {
    dependencies.readOnly = true;
    registerIpc(dependencies);

    await expect(ipcMain.invoke("zoro:projects:select")).rejects.toThrow(
      "只读恢复模式",
    );
    await expect(
      ipcMain.invoke("zoro:tasks:pause", { taskId: "task-1" }),
    ).rejects.toThrow("只读恢复模式");
    await expect(
      ipcMain.invoke("zoro:providers:create", {
        name: "团队模型",
        kind: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "team-code",
        contextLength: 128_000,
        headers: {},
        apiKey: "secret-value",
        isDefault: false,
      }),
    ).rejects.toThrow("只读恢复模式");

    expect(dependencies.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dependencies.runtime.pause).not.toHaveBeenCalled();
    expect(dependencies.modelGateway.createProvider).not.toHaveBeenCalled();
  });

  it("rejects every state-changing IPC while portable storage is unavailable", async () => {
    dependencies.appInfo.storageAvailable = false;
    registerIpc(dependencies);

    for (const channel of [
      "zoro:projects:select",
      "zoro:tasks:create",
      "zoro:tasks:pause",
      "zoro:tasks:resume",
      "zoro:tasks:retry",
      "zoro:tasks:add-message",
      "zoro:tasks:cancel",
      "zoro:tasks:resolve-approval",
      "zoro:routing:update",
      "zoro:providers:create",
      "zoro:providers:update",
      "zoro:providers:set-default",
      "zoro:providers:remove",
    ]) {
      await expect(ipcMain.invoke(channel)).rejects.toThrow("移动硬盘已断开");
    }

    expect(dependencies.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dependencies.runtime.createTask).not.toHaveBeenCalled();
    expect(dependencies.runtime.pause).not.toHaveBeenCalled();
    expect(dependencies.modelGateway.createProvider).not.toHaveBeenCalled();
  });

  it("reports restored storage but requires an application restart before task resume", async () => {
    let storageAvailable = false;
    let restartRequired = true;
    dependencies.appInfo = {
      ...dependencies.appInfo,
      get storageAvailable() {
        return storageAvailable;
      },
    };
    dependencies.storageRestartRequired = () => restartRequired;
    registerIpc(dependencies);

    await expect(ipcMain.invoke("zoro:app:info")).resolves.toMatchObject({
      storageAvailable: false,
    });
    storageAvailable = true;
    await expect(ipcMain.invoke("zoro:app:info")).resolves.toMatchObject({
      storageAvailable: true,
    });
    await expect(
      ipcMain.invoke("zoro:tasks:resume", { taskId: "task-1" }),
    ).rejects.toThrow("请重启 ZoroCoding 后继续任务");

    restartRequired = false;
    await ipcMain.invoke("zoro:tasks:resume", { taskId: "task-1" });
    expect(dependencies.runtime.resume).toHaveBeenCalledWith("task-1");
  });

  it("unregistering and re-registering IPC leaves exactly one current storage replay listener", () => {
    const unregisterFirst = registerIpc({
      ...dependencies,
      storageStatus: () => ({
        storageAvailable: false,
        restartRequired: true,
        generation: 1,
      }),
    });
    expect(
      ipcMain.listenerCount("zoro:app:storage-status:subscribe"),
    ).toBe(1);
    expect(
      ipcMain.listenerCount("zoro:app:storage-status:unsubscribe"),
    ).toBe(1);

    unregisterFirst();
    registerIpc({
      ...dependencies,
      storageStatus: () => ({
        storageAvailable: true,
        restartRequired: false,
        generation: 2,
      }),
    });

    expect(
      ipcMain.listenerCount("zoro:app:storage-status:subscribe"),
    ).toBe(1);
    expect(
      ipcMain.listenerCount("zoro:app:storage-status:unsubscribe"),
    ).toBe(1);
  });

  it("storage replay contains exactly storageAvailable restartRequired and generation and never uses a stale closure", () => {
    const unregisterStale = registerIpc({
      ...dependencies,
      storageStatus: () => ({
        storageAvailable: false,
        restartRequired: true,
        generation: 7,
      }),
    });
    unregisterStale();
    registerIpc({
      ...dependencies,
      storageStatus: () => ({
        storageAvailable: true,
        restartRequired: false,
        generation: 8,
      }),
    });
    const send = vi.fn();
    const event = fakeEvent({
      sender: {
        id: 9,
        send,
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
      },
    });

    ipcMain.emit("zoro:app:storage-status:subscribe", event);

    expect(send.mock.calls).toStrictEqual([
      [
        "zoro:app:storage-status",
        {
          storageAvailable: true,
          restartRequired: false,
          generation: 8,
        },
      ],
    ]);
  });
});
