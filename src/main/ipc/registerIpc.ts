import type { ExportController } from "../memory/exportController";
import { exportPreviewRequestSchema, exportConsentRequestSchema, exportRevokeRequestSchema } from "../../shared/memoryExport";
import { basename } from "node:path";
import type { z } from "zod";

import type {
  AgentRuntime,
  CreateTaskInput,
  TaskListener,
} from "../agent/agentRuntime";
import type {
  CreateProviderInput,
  ModelGateway,
  TestProviderInput,
  UpdateProviderInput,
} from "../models/modelGateway";
import type { ProviderRepository } from "../persistence/providerRepository";
import type { ModelRoutingRepository } from "../persistence/modelRoutingRepository";
import type { QuickChatRepository } from "../persistence/quickChatRepository";
import type {
  QuickChatEvent as QuickChatServiceEvent,
  QuickChatService,
} from "../quick-chat/quickChatService";
import type { ModelRouter } from "../routing/modelRouter";
import type { TaskRepository } from "../persistence/taskRepository";
import type {
  ProjectSummary,
  ProviderConfig,
  QuickChatMessage,
  QuickChatSession,
  TaskSnapshot,
} from "../../shared/domain";
import {
  quickChatMessageSchema,
  quickChatSessionSchema,
} from "../../shared/domain";
import {
  approvalRequestSchema,
  createProviderRequestSchema,
  createTaskRequestSchema,
  emptyIpcRequestSchema,
  providerIdRequestSchema,
  providerModelDiscoveryRequestSchema,
  quickChatEventEnvelopeSchema,
  quickChatEventSchema,
  quickChatRenameSessionRequestSchema,
  quickChatRetryRequestSchema,
  quickChatSendRequestSchema,
  quickChatSessionRequestSchema,
  quickChatSubscriptionRequestSchema,
  resolvedRouteViewSchema,
  routePreviewRequestSchema,
  routingConfigViewSchema,
  taskIdRequestSchema,
  taskEventEnvelopeSchema,
  taskListRequestSchema,
  taskMessageRequestSchema,
  taskSubscriptionIdSchema,
  testProviderRequestSchema,
  updateRoutingRequestSchema,
  updateProviderRequestSchema,
  type ProviderSummary,
  type AppInfo,
  type TaskDetail,
  type TaskEventEnvelope,
  type StorageStatus,
} from "../../shared/ipc";
import { authorizeProjectPath } from "../projects/projectBoundary";
import { PROVIDER_TEMPLATES } from "../models/providerTemplates";
import {
  MAX_TOOL_RESULT_TEXT_LENGTH,
  summarizeTaskToolResult,
} from "../../shared/taskEventLimits";

function rendererTaskEnvelope(
  subscriptionId: string,
  task: TaskSnapshot,
  taskEvent?: Parameters<TaskListener>[1],
): TaskEventEnvelope | null {
  const envelope = {
    subscriptionId,
    task,
    event: taskEvent,
  };
  const parsed = taskEventEnvelopeSchema.safeParse(envelope);
  if (parsed.success) {
    return parsed.data;
  }
  if (
    taskEvent?.type !== "tool_completed" ||
    taskEvent.payload.content.length <= MAX_TOOL_RESULT_TEXT_LENGTH
  ) {
    return null;
  }
  const summarized = taskEventEnvelopeSchema.safeParse({
    ...envelope,
    event: {
      ...taskEvent,
      payload: {
        ...taskEvent.payload,
        content: summarizeTaskToolResult(taskEvent.payload.content),
      },
    },
  });
  return summarized.success ? summarized.data : null;
}

export interface IpcSenderLike {
  id: number;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
}

export interface IpcEventLike {
  sender: IpcSenderLike;
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcEventLike, input?: unknown) => unknown,
  ): void;
  on(
    channel: string,
    listener: (event: IpcEventLike, input?: unknown) => void,
  ): void;
  removeHandler(channel: string): void;
  removeListener(channel: string, listener: (event: IpcEventLike, input?: unknown) => void): void;
}

export interface DialogLike {
  showOpenDialog(options: {
    properties: ["openDirectory"];
    defaultPath: string;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

type RuntimeLike = Pick<
  AgentRuntime,
  | "createTask"
  | "pause"
  | "resume"
  | "retry"
  | "addMessage"
  | "cancel"
  | "resolveApproval"
  | "subscribe"
>;

type ModelGatewayLike = Pick<
  ModelGateway,
  | "getProviderSnapshot"
  | "createProvider"
  | "updateProvider"
  | "deleteProvider"
  | "testDraft"
  | "discoverDraftModels"
  | "testAndRecordProvider"
>;

type ModelRoutingLike = Pick<ModelRoutingRepository, "get" | "update">;
type ModelRouterLike = Pick<ModelRouter, "resolve">;
type QuickChatRepositoryLike = Pick<
  QuickChatRepository,
  | "createSession"
  | "renameSession"
  | "deleteSession"
  | "listSessions"
  | "getSession"
  | "listMessages"
>;
type QuickChatServiceLike = Pick<
  QuickChatService,
  "send" | "cancel" | "retry" | "subscribe"
>;

export interface RegisterIpcDependencies {
  memoryExports?: ExportController;
  ipcMain: IpcMainLike;
  dialog: DialogLike;
  appInfo: AppInfo;
  tasks: TaskRepository;
  providers: ProviderRepository;
  quickChat: QuickChatRepositoryLike;
  quickChatService: QuickChatServiceLike;
  routing: ModelRoutingLike;
  modelRouter: ModelRouterLike;
  runtime: RuntimeLike;
  modelGateway: ModelGatewayLike;
  projectsRoot: string;
  expectedProjectsRoot: string;
  readOnly?: boolean;
  storageRestartRequired?: () => boolean;
  storageStatus?: () => StorageStatus;
  e2eAppInfoDelayMs?: number;
  now?: () => number;
  createId?: () => string;
}

interface Subscription {
  senderId: number;
  subscriptionId: string;
  unsubscribe: () => void;
}

interface SenderLifecycle {
  sender: IpcSenderLike;
  destroyedListener: () => void;
}

const invokeChannels = [
  "zoro:app:info",
  "zoro:projects:select",
  "zoro:projects:list",
  "zoro:tasks:list",
  "zoro:memory-exports:destinations",
  "zoro:memory-exports:preview",
  "zoro:memory-exports:consent",
  "zoro:memory-exports:list",
  "zoro:memory-exports:revoke",
  "zoro:memory-exports:flush",
  "zoro:tasks:get",
  "zoro:tasks:create",
  "zoro:tasks:pause",
  "zoro:tasks:resume",
  "zoro:tasks:retry",
  "zoro:tasks:add-message",
  "zoro:tasks:cancel",
  "zoro:tasks:resolve-approval",
  "zoro:routing:get",
  "zoro:routing:update",
  "zoro:routing:preview",
  "zoro:quick-chat:list-sessions",
  "zoro:quick-chat:create-session",
  "zoro:quick-chat:rename-session",
  "zoro:quick-chat:delete-session",
  "zoro:quick-chat:list-messages",
  "zoro:quick-chat:send",
  "zoro:quick-chat:cancel",
  "zoro:quick-chat:retry",
  "zoro:providers:list",
  "zoro:providers:templates",
  "zoro:providers:create",
  "zoro:providers:update",
  "zoro:providers:test",
  "zoro:providers:discover-models",
  "zoro:providers:test-saved",
  "zoro:providers:set-default",
  "zoro:providers:remove",
] as const;

function parseInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`${message}: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

function providerSummary(provider: ProviderConfig): ProviderSummary {
  const { secretRef: _secretRef, ...summary } = provider;
  return summary;
}

function requireTaskDetail(
  repository: TaskRepository,
  taskId: string,
): TaskDetail {
  const task = repository.get(taskId);
  if (task === null) {
    throw new Error(`任务 ${taskId} 不存在。`);
  }
  const project = repository.getProject(task.projectId);
  if (project === null) {
    throw new Error(`任务 ${taskId} 的项目记录不存在。`);
  }
  return {
    task,
    project,
    steps: repository.steps(taskId),
    events: repository.events(taskId),
    messages: repository.messages(taskId).map((item) => ({
      id: item.id,
      role: item.message.role,
      content: item.message.content,
      createdAt: item.createdAt,
    })),
    fileChanges: repository.fileChanges(taskId).map((item) => ({
      id: item.id,
      canonicalPath: item.canonicalPath,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      patch: item.patch,
      createdAt: item.createdAt,
    })),
  };
}

export function registerIpc(
  dependencies: RegisterIpcDependencies,
): () => void {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? crypto.randomUUID;
  const projectsRoot = dependencies.projectsRoot;
  const expectedProjectsRoot = dependencies.expectedProjectsRoot;
  const subscriptions = new Map<string, Subscription>();
  const quickChatSubscriptions = new Map<string, Subscription>();
  const senderLifecycles = new Map<number, SenderLifecycle>();
  let cleanupDepth = 0;
  let unregistering = false;
  const keyFor = (senderId: number, subscriptionId: string) =>
    `${senderId}:${subscriptionId}`;
  const requireStorage = () => {
    if (!dependencies.appInfo.storageAvailable) {
      throw new Error("移动硬盘已断开，无法执行会修改本地状态的操作。");
    }
    if (dependencies.storageRestartRequired?.() === true) {
      throw new Error("移动硬盘已恢复，请重启 ZoroCoding 后继续任务。");
    }
  };
  const requireWritable = () => {
    requireStorage();
    if (dependencies.readOnly === true) {
      throw new Error(
        "ZoroCoding 当前处于只读恢复模式，不能执行会修改本地状态的操作。",
      );
    }
  };
  const requireQuickChatSession = (
    sessionId: string,
  ): QuickChatSession => {
    const session = dependencies.quickChat.getSession(sessionId);
    if (session === null) {
      throw new Error(`快速问答会话 ${sessionId} 不存在。`);
    }
    return quickChatSessionSchema.parse(session) as QuickChatSession;
  };
  const requireProviderSnapshot = (providerId: string) => {
    const provider =
      dependencies.modelGateway.getProviderSnapshot(providerId);
    if (provider === null) {
      throw new Error(
        `Provider ${providerId} does not exist；模型供应商不存在。`,
      );
    }
    return provider;
  };
  const requireManualProvider = (
    selection: { mode: "auto" } | { mode: "manual"; providerId: string },
  ) => {
    if (selection.mode === "manual") {
      requireProviderSnapshot(selection.providerId);
    }
  };

  for (const channel of invokeChannels) {
    dependencies.ipcMain.removeHandler(channel);
  }

  const requireExports = () => {
    if (!dependencies.memoryExports) throw new Error("记忆导出未配置。");
    return dependencies.memoryExports;
  };
  dependencies.ipcMain.handle("zoro:memory-exports:destinations", () =>
    dependencies.memoryExports?.listDestinations() ?? [],
  );
  dependencies.ipcMain.handle("zoro:memory-exports:preview", (_event, input) => {
    requireWritable();
    const request = parseInput(exportPreviewRequestSchema, input, "导出预览请求无效");
    return requireExports().preview(requireTaskDetail(dependencies.tasks, request.taskId), request.destinationId);
  });
  dependencies.ipcMain.handle("zoro:memory-exports:consent", (_event, input) => {
    requireWritable();
    const request = parseInput(exportConsentRequestSchema, input, "导出同意请求无效");
    return requireExports().consent(request.token);
  });
  dependencies.ipcMain.handle("zoro:memory-exports:list", (_event, input) => {
    const request = parseInput(taskIdRequestSchema, input, "导出列表请求无效");
    return dependencies.memoryExports?.list(request.taskId) ?? [];
  });
  dependencies.ipcMain.handle("zoro:memory-exports:revoke", (_event, input) => {
    requireWritable();
    const request = parseInput(exportRevokeRequestSchema, input, "撤回导出请求无效");
    return requireExports().revoke(request.clientWriteId);
  });
  dependencies.ipcMain.handle("zoro:memory-exports:flush", (_event, input) => {
    requireWritable();
    const request = parseInput(taskIdRequestSchema, input, "发送导出请求无效");
    return requireExports().flush(request.taskId);
  });

  dependencies.ipcMain.handle("zoro:app:info", async () => {
    const delay = dependencies.e2eAppInfoDelayMs ?? 0;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    return {
      ...dependencies.appInfo,
    };
  });

  dependencies.ipcMain.handle("zoro:projects:select", async () => {
    requireWritable();
    const result = await dependencies.dialog.showOpenDialog({
      properties: ["openDirectory"],
      defaultPath: projectsRoot,
    });
    requireWritable();
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const canonicalPath = await authorizeProjectPath(
      projectsRoot,
      result.filePaths[0],
      expectedProjectsRoot,
    );
    requireWritable();
    const existing = dependencies.tasks
      .listProjects()
      .find((project) => project.canonicalPath === canonicalPath);
    const project: ProjectSummary = {
      id: existing?.id ?? createId(),
      name: basename(canonicalPath),
      canonicalPath,
      lastOpenedAt: now(),
    };
    dependencies.tasks.upsertProject(project);
    return project;
  });

  dependencies.ipcMain.handle("zoro:projects:list", () =>
    dependencies.tasks.listProjects(),
  );

  dependencies.ipcMain.handle("zoro:tasks:list", (_event, input) => {
    const request = parseInput(
      taskListRequestSchema,
      input ?? {},
      "Invalid list tasks request",
    );
    return dependencies.tasks.list(request.projectId);
  });

  dependencies.ipcMain.handle("zoro:tasks:get", (_event, input) => {
    const request = parseInput(
      taskIdRequestSchema,
      input,
      "Invalid get task request",
    );
    return requireTaskDetail(dependencies.tasks, request.taskId);
  });

  dependencies.ipcMain.handle(
    "zoro:tasks:create",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        createTaskRequestSchema,
        input,
        "Invalid create task request",
      );
      const project = dependencies.tasks.getProject(request.projectId);
      if (project === null) {
        throw new Error("所选项目未经过 ZoroCoding 文件夹选择器授权。");
      }
      const canonicalPath = await authorizeProjectPath(
        projectsRoot,
        project.canonicalPath,
        expectedProjectsRoot,
      );
      requireWritable();
      const resolved = dependencies.modelRouter.resolve({
        prompt: request.prompt,
        selection: request.selection,
      });
      const createInput: CreateTaskInput = {
        project: {
          ...project,
          canonicalPath,
        },
        prompt: request.prompt,
        provider: resolved.provider,
        routeDecision: resolved.decision,
        selectionMode: resolved.selectionMode,
      };
      const task = await dependencies.runtime.createTask(createInput);
      return requireTaskDetail(dependencies.tasks, task.id);
    },
  );

  for (const [channel, action] of [
    ["zoro:tasks:pause", dependencies.runtime.pause.bind(dependencies.runtime)],
    [
      "zoro:tasks:resume",
      dependencies.runtime.resume.bind(dependencies.runtime),
    ],
    [
      "zoro:tasks:retry",
      dependencies.runtime.retry.bind(dependencies.runtime),
    ],
    [
      "zoro:tasks:cancel",
      dependencies.runtime.cancel.bind(dependencies.runtime),
    ],
  ] as const) {
    dependencies.ipcMain.handle(channel, async (_event, input) => {
      requireWritable();
      const request = parseInput(
        taskIdRequestSchema,
        input,
        `Invalid ${channel} request`,
      );
      await action(request.taskId);
    });
  }

  dependencies.ipcMain.handle(
    "zoro:tasks:add-message",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        taskMessageRequestSchema,
        input,
        "Invalid task message request",
      );
      await dependencies.runtime.addMessage(
        request.taskId,
        request.content,
      );
    },
  );

  dependencies.ipcMain.handle(
    "zoro:tasks:resolve-approval",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        approvalRequestSchema,
        input,
        "Invalid approval request",
      );
      await dependencies.runtime.resolveApproval(
        request.taskId,
        request.decision === "allow_once" ? "allow" : "deny",
      );
    },
  );

  dependencies.ipcMain.handle("zoro:routing:get", (_event, input) => {
    requireStorage();
    parseInput(
      emptyIpcRequestSchema,
      input === undefined ? {} : input,
      "Invalid routing get request",
    );
    const config = dependencies.routing.get();
    if (config === null) {
      throw new Error("路由模型尚未初始化。");
    }
    return routingConfigViewSchema.parse(config);
  });

  dependencies.ipcMain.handle(
    "zoro:routing:update",
    (_event, input) => {
      requireWritable();
      const request = parseInput(
        updateRoutingRequestSchema,
        input,
        "Invalid routing update request",
      );
      requireProviderSnapshot(request.lightProviderId);
      requireProviderSnapshot(request.premiumProviderId);
      return routingConfigViewSchema.parse(
        dependencies.routing.update(request, now()),
      );
    },
  );

  dependencies.ipcMain.handle(
    "zoro:routing:preview",
    (_event, input) => {
      requireStorage();
      const request = parseInput(
        routePreviewRequestSchema,
        input,
        "Invalid route preview request",
      );
      requireManualProvider(request.selection);
      return resolvedRouteViewSchema.parse(
        dependencies.modelRouter.resolve(request),
      );
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:list-sessions",
    (_event, input) => {
      requireStorage();
      parseInput(
        emptyIpcRequestSchema,
        input === undefined ? {} : input,
        "Invalid Quick Chat list sessions request",
      );
      return dependencies.quickChat
        .listSessions()
        .map((session) => quickChatSessionSchema.parse(session));
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:create-session",
    (_event, input) => {
      requireWritable();
      parseInput(
        emptyIpcRequestSchema,
        input === undefined ? {} : input,
        "Invalid Quick Chat create session request",
      );
      const session: QuickChatSession = {
        id: createId(),
        title: "新对话",
        createdAt: now(),
        updatedAt: now(),
      };
      const parsed = quickChatSessionSchema.parse(session) as QuickChatSession;
      dependencies.quickChat.createSession(parsed);
      return parsed;
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:rename-session",
    (_event, input) => {
      requireWritable();
      const request = parseInput(
        quickChatRenameSessionRequestSchema,
        input,
        "Invalid Quick Chat rename session request",
      );
      const current = requireQuickChatSession(request.sessionId);
      const updated: QuickChatSession = {
        ...current,
        title: request.title,
        updatedAt: now(),
      };
      dependencies.quickChat.renameSession(
        updated.id,
        updated.title,
        updated.updatedAt,
      );
      return quickChatSessionSchema.parse(updated);
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:delete-session",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        quickChatSessionRequestSchema,
        input,
        "Invalid Quick Chat delete session request",
      );
      requireQuickChatSession(request.sessionId);
      await dependencies.quickChatService.cancel(request.sessionId);
      requireWritable();
      dependencies.quickChat.deleteSession(request.sessionId);
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:list-messages",
    (_event, input) => {
      requireStorage();
      const request = parseInput(
        quickChatSessionRequestSchema,
        input,
        "Invalid Quick Chat list messages request",
      );
      requireQuickChatSession(request.sessionId);
      return dependencies.quickChat
        .listMessages(request.sessionId)
        .map((message) => quickChatMessageSchema.parse(message));
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:send",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        quickChatSendRequestSchema,
        input,
        "Invalid Quick Chat send request",
      );
      requireQuickChatSession(request.sessionId);
      requireManualProvider(request.selection);
      const message = await dependencies.quickChatService.send(request);
      return quickChatMessageSchema.parse(message) as QuickChatMessage;
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:cancel",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        quickChatSessionRequestSchema,
        input,
        "Invalid Quick Chat cancel request",
      );
      requireQuickChatSession(request.sessionId);
      await dependencies.quickChatService.cancel(request.sessionId);
    },
  );

  dependencies.ipcMain.handle(
    "zoro:quick-chat:retry",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        quickChatRetryRequestSchema,
        input,
        "Invalid Quick Chat retry request",
      );
      requireQuickChatSession(request.sessionId);
      requireManualProvider(request.selection);
      const message = await dependencies.quickChatService.retry(request);
      return quickChatMessageSchema.parse(message) as QuickChatMessage;
    },
  );

  dependencies.ipcMain.handle("zoro:providers:list", () =>
    dependencies.providers.list().map(providerSummary),
  );

  dependencies.ipcMain.handle("zoro:providers:templates", () =>
    PROVIDER_TEMPLATES.map((template) => ({ ...template })),
  );

  dependencies.ipcMain.handle(
    "zoro:providers:create",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        createProviderRequestSchema,
        input,
        "Invalid create provider request",
      );
      const createInput: CreateProviderInput = {
        ...request,
        id: createId(),
        now: now(),
      };
      return providerSummary(
        await dependencies.modelGateway.createProvider(createInput),
      );
    },
  );

  dependencies.ipcMain.handle(
    "zoro:providers:update",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        updateProviderRequestSchema,
        input,
        "Invalid update provider request",
      );
      const updateInput: UpdateProviderInput = {
        ...request.input,
        now: now(),
      };
      return providerSummary(
        await dependencies.modelGateway.updateProvider(
          request.id,
          updateInput,
        ),
      );
    },
  );

  dependencies.ipcMain.handle(
    "zoro:providers:test",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        testProviderRequestSchema,
        input,
        "Invalid provider test request",
      );
      const testInput: TestProviderInput = request;
      return dependencies.modelGateway.testDraft(testInput);
    },
  );

  dependencies.ipcMain.handle(
    "zoro:providers:discover-models",
    (_event, input) => {
      requireWritable();
      const request = parseInput(
        providerModelDiscoveryRequestSchema,
        input,
        "Invalid provider model discovery request",
      );
      return dependencies.modelGateway.discoverDraftModels(request);
    },
  );

  dependencies.ipcMain.handle(
    "zoro:providers:test-saved",
    (_event, input) => {
      requireWritable();
      const request = parseInput(
        providerIdRequestSchema,
        input,
        "Invalid saved provider test request",
      );
      return dependencies.modelGateway.testAndRecordProvider(request.id);
    },
  );

  dependencies.ipcMain.handle(
    "zoro:providers:set-default",
    (_event, input) => {
      requireWritable();
      const request = parseInput(
        providerIdRequestSchema,
        input,
        "Invalid default provider request",
      );
      dependencies.providers.setDefault(request.id, now());
    },
  );

  dependencies.ipcMain.handle(
    "zoro:providers:remove",
    async (_event, input) => {
      requireWritable();
      const request = parseInput(
        providerIdRequestSchema,
        input,
        "Invalid remove provider request",
      );
      const routing = dependencies.routing.get();
      if (
        routing?.lightProviderId === request.id ||
        routing?.premiumProviderId === request.id
      ) {
        throw new Error(
          "该模型正在用于自动路由，请先更换路由模型后再删除。",
        );
      }
      await dependencies.modelGateway.deleteProvider(request.id);
    },
  );

  const storageSubscribe = (event: IpcEventLike) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(
          "zoro:app:storage-status",
          dependencies.storageStatus?.() ?? {
            storageAvailable: dependencies.appInfo.storageAvailable,
            restartRequired: dependencies.storageRestartRequired?.() ?? false,
            generation: 0,
          },
        );
      }
  };
  const storageUnsubscribe = () => {};
  dependencies.ipcMain.on("zoro:app:storage-status:subscribe", storageSubscribe);

  dependencies.ipcMain.on("zoro:app:storage-status:unsubscribe", storageUnsubscribe);

  const runUnsubscribes = (callbacks: Array<() => void>) => {
    cleanupDepth += 1;
    try {
      for (const callback of callbacks) {
        try {
          callback();
        } catch {
          // Listener cleanup is best-effort and must not retain other entries.
        }
      }
    } finally {
      cleanupDepth -= 1;
    }
  };
  const hasSenderSubscriptions = (senderId: number) =>
    [...subscriptions.values()].some(
      (subscription) => subscription.senderId === senderId,
    ) ||
    [...quickChatSubscriptions.values()].some(
      (subscription) => subscription.senderId === senderId,
    );
  const detachSenderLifecycle = (senderId: number) => {
    const lifecycle = senderLifecycles.get(senderId);
    if (lifecycle === undefined) {
      return;
    }
    senderLifecycles.delete(senderId);
    try {
      lifecycle.sender.removeListener(
        "destroyed",
        lifecycle.destroyedListener,
      );
    } catch {
      // A destroyed renderer may already have removed its one-shot hook.
    }
  };
  const detachUnusedSenderLifecycle = (senderId: number) => {
    if (!hasSenderSubscriptions(senderId)) {
      detachSenderLifecycle(senderId);
    }
  };
  const detachSubscription = (
    activeSubscriptions: Map<string, Subscription>,
    key: string,
  ): (() => void) | null => {
    const subscription = activeSubscriptions.get(key);
    if (subscription === undefined) {
      return null;
    }
    activeSubscriptions.delete(key);
    detachUnusedSenderLifecycle(subscription.senderId);
    return subscription.unsubscribe;
  };
  const disposeSubscription = (
    activeSubscriptions: Map<string, Subscription>,
    key: string,
  ) => {
    const unsubscribe = detachSubscription(activeSubscriptions, key);
    if (unsubscribe !== null) {
      runUnsubscribes([unsubscribe]);
    }
  };
  const cleanupSender = (senderId: number) => {
    detachSenderLifecycle(senderId);
    const callbacks: Array<() => void> = [];
    for (const [key, subscription] of subscriptions) {
      if (subscription.senderId === senderId) {
        subscriptions.delete(key);
        callbacks.push(subscription.unsubscribe);
      }
    }
    for (const [key, subscription] of quickChatSubscriptions) {
      if (subscription.senderId === senderId) {
        quickChatSubscriptions.delete(key);
        callbacks.push(subscription.unsubscribe);
      }
    }
    runUnsubscribes(callbacks);
  };
  const ensureSenderLifecycle = (sender: IpcSenderLike) => {
    if (senderLifecycles.has(sender.id)) {
      return;
    }
    const destroyedListener = () => {
      cleanupSender(sender.id);
    };
    senderLifecycles.set(sender.id, { sender, destroyedListener });
    sender.once("destroyed", destroyedListener);
  };
  const acceptsSubscription = (sender: IpcSenderLike) =>
    !unregistering && cleanupDepth === 0 && !sender.isDestroyed();
  const cleanupAllSubscriptions = () => {
    for (const senderId of [...senderLifecycles.keys()]) {
      detachSenderLifecycle(senderId);
    }
    const callbacks = [
      ...[...subscriptions.values()].map(
        (subscription) => subscription.unsubscribe,
      ),
      ...[...quickChatSubscriptions.values()].map(
        (subscription) => subscription.unsubscribe,
      ),
    ];
    subscriptions.clear();
    quickChatSubscriptions.clear();
    runUnsubscribes(callbacks);
  };

  const taskSubscribe = (event: IpcEventLike, input?: unknown) => {
    const parsedSubscriptionId = taskSubscriptionIdSchema.safeParse(input);
    if (
      !acceptsSubscription(event.sender) ||
      !parsedSubscriptionId.success
    ) {
      return;
    }
    const subscriptionId = parsedSubscriptionId.data;
    const key = keyFor(event.sender.id, subscriptionId);
    disposeSubscription(subscriptions, key);
    if (!acceptsSubscription(event.sender)) {
      return;
    }
    const listener: TaskListener = (
      task: TaskSnapshot,
      taskEvent,
    ) => {
      if (event.sender.isDestroyed()) {
        return;
      }
      try {
        const envelope = rendererTaskEnvelope(
          subscriptionId,
          task,
          taskEvent,
        );
        if (envelope !== null && !event.sender.isDestroyed()) {
          event.sender.send("zoro:tasks:event", envelope);
        }
      } catch {
        // Invalid payloads and renderer send failures are isolated here.
      }
    };
    const unsubscribe = dependencies.runtime.subscribe(listener);
    subscriptions.set(key, {
      senderId: event.sender.id,
      subscriptionId,
      unsubscribe,
    });
    ensureSenderLifecycle(event.sender);
  };

  const taskUnsubscribe = (event: IpcEventLike, input?: unknown) => {
    const parsedSubscriptionId = taskSubscriptionIdSchema.safeParse(input);
    if (!parsedSubscriptionId.success) {
      return;
    }
    const key = keyFor(event.sender.id, parsedSubscriptionId.data);
    disposeSubscription(subscriptions, key);
  };

  const quickChatSubscribe = (
    event: IpcEventLike,
    input?: unknown,
  ) => {
    const request = quickChatSubscriptionRequestSchema.safeParse(input);
    if (!acceptsSubscription(event.sender) || !request.success) {
      return;
    }
    const { subscriptionId } = request.data;
    const key = keyFor(event.sender.id, subscriptionId);
    disposeSubscription(quickChatSubscriptions, key);
    if (!acceptsSubscription(event.sender)) {
      return;
    }
    const unsubscribe = dependencies.quickChatService.subscribe(
      (serviceEvent: QuickChatServiceEvent) => {
        if (event.sender.isDestroyed()) {
          return;
        }
        const parsedEvent = quickChatEventSchema.safeParse(serviceEvent);
        if (!parsedEvent.success) {
          return;
        }
        const envelope = quickChatEventEnvelopeSchema.parse({
          subscriptionId,
          event: parsedEvent.data,
        });
        event.sender.send("zoro:quick-chat:event", envelope);
      },
    );
    quickChatSubscriptions.set(key, {
      senderId: event.sender.id,
      subscriptionId,
      unsubscribe,
    });
    ensureSenderLifecycle(event.sender);
  };

  const quickChatUnsubscribe = (
    event: IpcEventLike,
    input?: unknown,
  ) => {
    const request = quickChatSubscriptionRequestSchema.safeParse(input);
    if (!request.success) {
      return;
    }
    const key = keyFor(event.sender.id, request.data.subscriptionId);
    disposeSubscription(quickChatSubscriptions, key);
  };

  dependencies.ipcMain.on("zoro:tasks:subscribe", taskSubscribe);
  dependencies.ipcMain.on("zoro:tasks:unsubscribe", taskUnsubscribe);
  dependencies.ipcMain.on(
    "zoro:quick-chat:subscribe",
    quickChatSubscribe,
  );
  dependencies.ipcMain.on(
    "zoro:quick-chat:unsubscribe",
    quickChatUnsubscribe,
  );

  return () => {
    if (unregistering) {
      return;
    }
    unregistering = true;
    for (const channel of invokeChannels) {
      dependencies.ipcMain.removeHandler(channel);
    }
    dependencies.ipcMain.removeListener("zoro:app:storage-status:subscribe", storageSubscribe);
    dependencies.ipcMain.removeListener("zoro:app:storage-status:unsubscribe", storageUnsubscribe);
    dependencies.ipcMain.removeListener("zoro:tasks:subscribe", taskSubscribe);
    dependencies.ipcMain.removeListener("zoro:tasks:unsubscribe", taskUnsubscribe);
    dependencies.ipcMain.removeListener(
      "zoro:quick-chat:subscribe",
      quickChatSubscribe,
    );
    dependencies.ipcMain.removeListener(
      "zoro:quick-chat:unsubscribe",
      quickChatUnsubscribe,
    );
    cleanupAllSubscriptions();
  };
}
