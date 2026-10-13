import { z } from "zod";

import type {
  ProjectSummary,
  ModelOption,
  ProviderConfig,
  ProviderKind,
  ProviderSnapshot,
  ProviderTemplate,
  QuickChatMessage,
  QuickChatSession,
  TaskEvent,
  TaskSnapshot,
  TaskStep,
} from "./domain";
import {
  providerSnapshotSchema,
  quickChatMessageSchema,
  quickChatSessionSchema,
  routeDecisionSchema,
  taskEventSchema,
  taskSnapshotSchema,
} from "./domain";
import {
  addEndpointSecurityIssues,
  addProviderSecurityIssues,
  providerBaseObject,
} from "./providerValidation";
import type { ModelSelection, RouteDecision } from "./taskRouting";

const integrationIdSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z][a-z0-9-]*$/);

export const integrationOptionsSchema = z.object({
  readEnabled: z.boolean().default(false),
  writeEnabled: z.boolean().default(false),
  projectIds: z.array(z.string().min(1).max(120)).max(1000).default([]),
  reviewer: z.enum(["manual", "http"]).default("manual"),
  unavailablePolicy: z.enum(["block", "manual"]).default("block"),
}).strict();

export type IntegrationOptions = z.infer<typeof integrationOptionsSchema>;

const integrationSettingsObject = z.object({
  id: integrationIdSchema,
  enabled: z.boolean().default(false),
  endpoint: z.union([z.string().trim().url(), z.literal("")]).default(""),
  options: integrationOptionsSchema.optional(),
}).strict();

function validateIntegrationEndpoint(
  input: { enabled: boolean; endpoint: string },
  context: z.RefinementCtx,
): void {
  if (input.enabled && input.endpoint === "") {
    context.addIssue({
      code: "custom",
      path: ["endpoint"],
      message: "启用集成前必须配置服务地址。",
    });
  }
  if (input.endpoint !== "") {
    addEndpointSecurityIssues(input.endpoint, context, "endpoint");
  }
}

export const integrationSettingsViewSchema = integrationSettingsObject.extend({
  keySuffix: z.string().max(4),
  updatedAt: z.number().int().nonnegative(),
}).superRefine(validateIntegrationEndpoint);

export const integrationIdRequestSchema = z.object({
  id: integrationIdSchema,
}).strict();

export const updateIntegrationSettingsRequestSchema = integrationSettingsObject.extend({
  // Omitted retains the saved token; an empty string clears it.
  token: z.union([z.string().trim().min(5).max(16_384), z.literal("")]).optional(),
}).superRefine(validateIntegrationEndpoint);

export type IntegrationSettingsView = z.infer<typeof integrationSettingsViewSchema>;
export type UpdateIntegrationSettingsRequest = z.input<typeof updateIntegrationSettingsRequestSchema>;

export type TaskSummary = TaskSnapshot;

export interface TaskMessageView {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  createdAt: number;
}

export interface FileChangeView {
  id: string;
  canonicalPath: string;
  beforeHash: string;
  afterHash: string;
  patch: string;
  createdAt: number;
}

export interface TaskDetail {
  task: TaskSnapshot;
  project: ProjectSummary;
  steps: TaskStep[];
  events: TaskEvent[];
  messages: TaskMessageView[];
  fileChanges: FileChangeView[];
}

export type ProviderSummary = Omit<ProviderConfig, "secretRef">;

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
  contextLength: number;
  headers: Record<string, string>;
  apiKey?: string;
  isDefault: boolean;
  billingNote?: string;
  dashboardUrl?: string;
}

export interface ProviderTestInput extends ProviderInput {
  apiKey: string;
}

export interface ProviderModelDiscoveryInput {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

export interface CreateTaskRequest {
  projectId: string;
  prompt: string;
  selection: ModelSelection;
}

export interface RoutingConfigView {
  lightProviderId: string | null;
  premiumProviderId: string | null;
  updatedAt: number;
}

export interface UpdateRoutingConfigRequest {
  lightProviderId: string;
  premiumProviderId: string;
}

export interface RoutePreviewRequest {
  prompt: string;
  selection: ModelSelection;
}

export interface ResolvedRouteView {
  decision: RouteDecision;
  selectionMode: "auto" | "manual";
  provider: ProviderSnapshot;
}

export interface ConnectionResultView {
  ok: true;
  latencyMs: number;
}

export interface AppInfo {
  portable: true;
  volumeName: string;
  dataRoot: string;
  projectsRoot: string;
  storageAvailable: boolean;
  restartRequired: boolean;
}

export interface StorageStatus {
  storageAvailable: boolean;
  restartRequired: boolean;
  generation: number;
}

export interface TaskEventEnvelope {
  subscriptionId: string;
  task: TaskSnapshot;
  event?: TaskEvent;
}

export interface QuickChatSendRequest {
  sessionId: string;
  prompt: string;
  selection: ModelSelection;
}

export interface QuickChatRetryRequest {
  sessionId: string;
  messageId: string;
  selection: ModelSelection;
}

export type QuickChatEvent =
  | { type: "session_updated"; session: QuickChatSession }
  | { type: "message_started"; message: QuickChatMessage }
  | {
      type: "message_delta";
      sessionId: string;
      messageId: string;
      text: string;
    }
  | { type: "message_completed"; message: QuickChatMessage }
  | { type: "message_failed"; message: QuickChatMessage };

export interface QuickChatEventEnvelope {
  subscriptionId: string;
  event: QuickChatEvent;
}

function hasOnlyPlainObjectPrototypes(
  value: unknown,
  visited = new Set<object>(),
): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (visited.has(value)) {
    return true;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    return value.every((item) =>
      hasOnlyPlainObjectPrototypes(item, visited),
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.keys(value).every((key) =>
    hasOnlyPlainObjectPrototypes(
      (value as Record<string, unknown>)[key],
      visited,
    ),
  );
}

function hasOnlyBoundedPlainTaskObjects(
  value: unknown,
  visited = new Set<object>(),
  depth = 0,
): boolean {
  if (depth > 23) return false;
  if (value === null || typeof value !== "object") return true;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return (
      value.length <= 500 &&
      value.every((item) =>
        hasOnlyBoundedPlainTaskObjects(item, visited, depth + 1),
      )
    );
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Object.keys(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    keys.length <= 500 &&
    keys.every((key) =>
      hasOnlyBoundedPlainTaskObjects(
        (value as Record<string, unknown>)[key],
        visited,
        depth + 1,
      ),
    )
  );
}

const ipcIdentifierSchema = z.string().trim().min(1).max(256);

export const emptyIpcRequestSchema = z.object({}).strict();

export const modelSelectionSchema: z.ZodType<ModelSelection> =
  z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }).strict(),
    z
      .object({
        mode: z.literal("manual"),
        providerId: ipcIdentifierSchema,
      })
      .strict(),
  ]);

export const createTaskRequestSchema = z
  .object({
    projectId: z.string().min(1),
    prompt: z.string().trim().min(1).max(100_000),
    selection: modelSelectionSchema,
  })
  .strict();

export const updateRoutingRequestSchema: z.ZodType<UpdateRoutingConfigRequest> = z
  .object({
    lightProviderId: ipcIdentifierSchema,
    premiumProviderId: ipcIdentifierSchema,
  })
  .strict();

export const routePreviewRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(100_000),
    selection: modelSelectionSchema,
  })
  .strict();

export const routingConfigViewSchema: z.ZodType<RoutingConfigView> = z
  .object({
    lightProviderId: ipcIdentifierSchema.nullable(),
    premiumProviderId: ipcIdentifierSchema.nullable(),
    updatedAt: z.number().finite(),
  })
  .strict();

export const resolvedRouteViewSchema: z.ZodType<ResolvedRouteView> = z
  .object({
    decision: routeDecisionSchema,
    selectionMode: z.enum(["auto", "manual"]),
    provider: providerSnapshotSchema,
  })
  .strict();

export const quickChatSessionRequestSchema = z
  .object({
    sessionId: ipcIdentifierSchema,
  })
  .strict();

export const quickChatRenameSessionRequestSchema = z
  .object({
    sessionId: ipcIdentifierSchema,
    title: z.string().trim().min(1).max(100),
  })
  .strict();

export const quickChatSendRequestSchema: z.ZodType<QuickChatSendRequest> = z
  .object({
    sessionId: ipcIdentifierSchema,
    prompt: z.string().trim().min(1).max(100_000),
    selection: modelSelectionSchema,
  })
  .strict();

export const quickChatRetryRequestSchema: z.ZodType<QuickChatRetryRequest> = z
  .object({
    sessionId: ipcIdentifierSchema,
    messageId: ipcIdentifierSchema,
    selection: modelSelectionSchema,
  })
  .strict();

export const quickChatSubscriptionRequestSchema = z
  .object({
    subscriptionId: ipcIdentifierSchema,
  })
  .strict();

export const quickChatEventSchema: z.ZodType<QuickChatEvent> =
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("session_updated"),
        session: quickChatSessionSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("message_started"),
        message: quickChatMessageSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("message_delta"),
        sessionId: ipcIdentifierSchema,
        messageId: ipcIdentifierSchema,
        text: z.string().max(100_000),
      })
      .strict(),
    z
      .object({
        type: z.literal("message_completed"),
        message: quickChatMessageSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("message_failed"),
        message: quickChatMessageSchema,
      })
      .strict(),
  ]);

const quickChatEventEnvelopeObjectSchema = z
  .object({
    subscriptionId: ipcIdentifierSchema,
    event: quickChatEventSchema,
  })
  .strict();

export const quickChatEventEnvelopeSchema: z.ZodType<QuickChatEventEnvelope> =
  z
    .custom<unknown>(hasOnlyPlainObjectPrototypes, {
      error: "Expected plain Quick Chat event objects",
    })
    .pipe(quickChatEventEnvelopeObjectSchema);

const taskEventEnvelopeObjectSchema = z
  .object({
    subscriptionId: ipcIdentifierSchema,
    task: taskSnapshotSchema,
    event: taskEventSchema.optional(),
  })
  .strict();

export const taskEventEnvelopeSchema: z.ZodType<TaskEventEnvelope> =
  z
    .custom<unknown>(hasOnlyBoundedPlainTaskObjects, {
      error: "Expected plain task event objects",
    })
    .pipe(taskEventEnvelopeObjectSchema);

export const taskSubscriptionIdSchema = ipcIdentifierSchema;

export const taskIdRequestSchema = z
  .object({ taskId: z.string().min(1) })
  .strict();

export const taskMessageRequestSchema = z
  .object({
    taskId: z.string().min(1),
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const taskListRequestSchema = z
  .object({ projectId: z.string().min(1).optional() })
  .strict();

export const approvalRequestSchema = z
  .object({
    taskId: z.string().min(1),
    decision: z.enum(["allow_once", "deny"]),
  })
  .strict();

export const createProviderRequestSchema = providerBaseObject
  .extend({
    apiKey: z.string().min(1),
  })
  .superRefine(addProviderSecurityIssues);

export const updateProviderRequestSchema = z
  .object({
    id: z.string().min(1),
    input: providerBaseObject
      .extend({
        apiKey: z.string().min(1).optional(),
      })
      .superRefine(addProviderSecurityIssues),
  })
  .strict();

export const testProviderRequestSchema = providerBaseObject
  .extend({
    apiKey: z.string().min(1),
  })
  .superRefine(addProviderSecurityIssues);

export const providerIdRequestSchema = z
  .object({ id: z.string().min(1) })
  .strict();

export const providerModelDiscoveryRequestSchema = z
  .object({
    baseUrl: z.string().trim().url(),
    apiKey: z.string().trim().min(1).max(4_096),
    headers: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((input, context) =>
    addProviderSecurityIssues(
      {
        name: "Model discovery",
        kind: "openai-compatible",
        baseUrl: input.baseUrl,
        modelId: "model-discovery",
        contextLength: 1_024,
        headers: input.headers,
        isDefault: false,
      },
      context,
    ),
  );

export interface ZoroApi {
  app: {
    info(): Promise<AppInfo>;
    subscribeStorageStatus(listener: (status: StorageStatus) => void): () => void;
  };
  projects: {
    select(): Promise<ProjectSummary | null>;
    list(): Promise<ProjectSummary[]>;
  };
  tasks: {
    list(projectId?: string): Promise<TaskSummary[]>;
    get(taskId: string): Promise<TaskDetail>;
    create(input: CreateTaskRequest): Promise<TaskDetail>;
    pause(taskId: string): Promise<void>;
    resume(taskId: string): Promise<void>;
    retry(taskId: string): Promise<void>;
    addMessage(taskId: string, content: string): Promise<void>;
    cancel(taskId: string): Promise<void>;
    resolveApproval(
      taskId: string,
      decision: "allow_once" | "deny",
    ): Promise<void>;
    subscribe(listener: (event: TaskEventEnvelope) => void): () => void;
  };
  routing: {
    get(): Promise<RoutingConfigView>;
    update(input: UpdateRoutingConfigRequest): Promise<RoutingConfigView>;
    preview(input: RoutePreviewRequest): Promise<ResolvedRouteView>;
  };
  quickChat: {
    listSessions(): Promise<QuickChatSession[]>;
    createSession(): Promise<QuickChatSession>;
    renameSession(
      sessionId: string,
      title: string,
    ): Promise<QuickChatSession>;
    deleteSession(sessionId: string): Promise<void>;
    listMessages(sessionId: string): Promise<QuickChatMessage[]>;
    send(input: QuickChatSendRequest): Promise<QuickChatMessage>;
    cancel(sessionId: string): Promise<void>;
    retry(input: QuickChatRetryRequest): Promise<QuickChatMessage>;
    subscribe(
      listener: (event: QuickChatEventEnvelope) => void,
    ): () => void;
  };
  integrations: {
    get(id: string): Promise<IntegrationSettingsView>;
    update(input: UpdateIntegrationSettingsRequest): Promise<IntegrationSettingsView>;
  };
  providers: {
    list(): Promise<ProviderSummary[]>;
    templates(): Promise<ProviderTemplate[]>;
    create(input: ProviderInput & { apiKey: string }): Promise<ProviderSummary>;
    update(id: string, input: ProviderInput): Promise<ProviderSummary>;
    test(input: ProviderTestInput): Promise<ConnectionResultView>;
    discoverModels(input: ProviderModelDiscoveryInput): Promise<ModelOption[]>;
    testSaved(id: string): Promise<ConnectionResultView>;
    setDefault(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
}
