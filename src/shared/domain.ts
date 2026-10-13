import { z } from "zod";
import type {
  ModelSelection,
  RouteDecision,
  TaskExecutionMode,
} from "./taskRouting";
import {
  TOOL_NAME_VALUES,
  type ToolName,
} from "./toolNames";
import {
  MAX_TASK_TEXT_LENGTH,
  MAX_TOOL_RESULT_TEXT_LENGTH,
} from "./taskEventLimits";

export { TOOL_NAME_VALUES } from "./toolNames";
export type { ToolName } from "./toolNames";

export type ProviderKind = "kimi" | "openai-compatible";

export interface ProviderTemplate {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  suggestedModelId?: string;
  requiresDiscovery: boolean;
  contextLength: number;
  billingNote: string;
  dashboardUrl: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

export type ProviderConnectionStatus = "untested" | "connected" | "error";

export interface ProviderSnapshot {
  providerId: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
  contextLength: number;
}

export type QuickChatMessageStatus =
  | "streaming"
  | "completed"
  | "failed"
  | "canceled";

export interface QuickChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface QuickChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  providerSnapshot: ProviderSnapshot | null;
  routeDecision: RouteDecision | null;
  status: QuickChatMessageStatus;
  errorMessage: string | null;
  createdAt: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
  contextLength: number;
  headers: Record<string, string>;
  secretRef: string;
  keySuffix: string;
  isDefault: boolean;
  connectionStatus: ProviderConnectionStatus;
  connectionMessage: string | null;
  lastTestedAt: number | null;
  billingNote: string;
  dashboardUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  canonicalPath: string;
  lastOpenedAt: number;
}

export type PermissionLevel = "allow" | "ask" | "deny";

export interface PermissionDecision {
  level: PermissionLevel;
  summary: string;
  reasons: string[];
  canonicalTarget?: string;
}

export type ToolOperation =
  | {
      kind: "read_file" | "write_file" | "delete_path";
      path: string;
    }
  | {
      kind: "shell";
      command: string;
    };

export const toolNameSchema: z.ZodType<ToolName> = z.enum(
  TOOL_NAME_VALUES,
);

const boundedIdentifierSchema = z.string().min(1).max(256);
const boundedTextSchema = z.string().max(MAX_TASK_TEXT_LENGTH);
const boundedToolResultSchema = z
  .string()
  .max(MAX_TOOL_RESULT_TEXT_LENGTH);
const taskEventDataSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    boundedTextSchema,
    z.array(taskEventDataSchema).max(500),
    z
      .record(z.string().max(256), taskEventDataSchema)
      .refine((value) => Object.keys(value).length <= 500),
  ]),
);

export interface ToolCall {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: ToolName;
  ok: boolean;
  content: string;
  denied?: boolean;
  data?: Record<string, unknown>;
}

export type TaskStatus =
  | "draft"
  | "planning"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface TaskStep {
  id: string;
  taskId: string;
  order: number;
  title: string;
  completionCriteria: string;
  estimateSeconds: number;
  actualSeconds: number | null;
  observedFraction: number;
  status: StepStatus;
}

export interface ProgressSnapshot {
  percent: number;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  estimationState: "ready" | "recalculating" | "paused";
}

export type TaskPauseReason =
  | "user"
  | "approval"
  | "backoff"
  | "interrupted"
  | null;

export interface TaskSnapshot {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  providerSnapshot: ProviderSnapshot;
  routeDecision: RouteDecision;
  selectionMode: "auto" | "manual";
  executionMode: TaskExecutionMode;
  progress: ProgressSnapshot;
  currentStepId: string | null;
  activeSince: number | null;
  pausedSince: number | null;
  pauseReason: TaskPauseReason;
  createdAt: number;
  updatedAt: number;
}

interface TaskEventBase {
  id: string;
  taskId: string;
  at: number;
}

export type TaskEvent =
  | (TaskEventBase & {
      type: "memory_context_loaded";
      payload: { entryCount: number; charCount: number };
    })
  | (TaskEventBase & {
      type: "planning_started";
      payload: Record<string, never>;
    })
  | (TaskEventBase & {
      type: "plan_created";
      payload: {
        title: string;
      };
    })
  | (TaskEventBase & {
      type: "step_started";
      payload: {
        stepId: string;
      };
    })
  | (TaskEventBase & {
      type: "step_completed";
      payload: {
        stepId: string;
        actualSeconds: number;
      };
    })
  | (TaskEventBase & {
      type: "tool_started";
      payload: {
        callId: string;
        name: ToolName;
        inputSummary: string;
        fingerprint?: string;
      };
    })
  | (TaskEventBase & {
      type: "tool_completed";
      payload: {
        callId: string;
        name: ToolName;
        ok: boolean;
        content: string;
        denied: boolean;
        data: Record<string, unknown>;
        fingerprint?: string;
      };
    })
  | (TaskEventBase & {
      type: "model_output";
      payload: {
        text: string;
      };
    })
  | (TaskEventBase & {
      type: "tool_output";
      payload: {
        callId: string;
        stream: "stdout" | "stderr";
        text: string;
      };
    })
  | (TaskEventBase & {
      type: "app_interrupted";
      payload: Record<string, never>;
    })
  | (TaskEventBase & {
      type: "approval_requested";
      payload: {
        approvalId: string;
        summary: string;
        reasons: string[];
      };
    })
  | (TaskEventBase & {
      type: "approval_resolved";
      payload: {
        approvalId: string;
        decision: "allow" | "deny";
        pausedSeconds: number;
      };
    })
  | (TaskEventBase & {
      type: "backoff_started";
      payload: {
        attempt: number;
        delayMs: number;
        phase: "planning" | "running";
      };
    })
  | (TaskEventBase & {
      type: "backoff_finished";
      payload: {
        phase: "planning" | "running";
        pausedSeconds: number;
      };
    })
  | (TaskEventBase & {
      type: "task_paused";
      payload: {
        phase: "planning" | "running";
      };
    })
  | (TaskEventBase & {
      type: "task_resumed";
      payload: {
        phase: "planning" | "running";
        pausedSeconds: number;
      };
    })
  | (TaskEventBase & {
      type: "task_failed";
      payload: {
        message: string;
      };
    })
  | (TaskEventBase & {
      type: "task_retried";
      payload: {
        phase: "planning" | "running";
      };
    })
  | (TaskEventBase & {
      type: "task_canceled";
      payload: Record<string, never>;
    })
  | (TaskEventBase & {
      type: "task_completed";
      payload: Record<string, never>;
    });

export const providerSnapshotSchema = z.object({
  providerId: boundedIdentifierSchema,
  name: boundedTextSchema.min(1),
  kind: z.enum(["kimi", "openai-compatible"]),
  baseUrl: z.string().min(1).max(4_096),
  modelId: boundedTextSchema.min(1),
  contextLength: z.number().int().positive(),
}).strict();

export const progressSnapshotSchema = z.object({
  percent: z.number().min(0).max(100),
  elapsedSeconds: z.number().nonnegative(),
  remainingSeconds: z.number().nonnegative().nullable(),
  estimationState: z.enum(["ready", "recalculating", "paused"]),
}).strict();

export const taskExecutionModeSchema: z.ZodType<TaskExecutionMode> = z.enum([
  "read_only",
  "agentic",
]);

export const routeDecisionSchema: z.ZodType<RouteDecision> = z.object({
  intent: z.enum([
    "simple_qa",
    "simple_text",
    "simple_code",
    "complex_code",
    "media_script",
  ]),
  lane: z.enum(["light", "premium"]),
  executionMode: taskExecutionModeSchema,
  confidence: z.enum(["high", "medium"]),
  reasonCode: z.enum([
    "simple-question",
    "text-transform",
    "code-explanation",
    "project-change",
    "multi-step-code",
    "media-generation",
    "ambiguous-premium-default",
  ]),
}).strict();

export const quickChatMessageStatusSchema = z.enum([
  "streaming",
  "completed",
  "failed",
  "canceled",
]);

export const quickChatSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const quickChatMessageSchema: z.ZodType<QuickChatMessage> =
  z.discriminatedUnion("role", [
    z.object({
      id: z.string().min(1),
      sessionId: z.string().min(1),
      role: z.literal("user"),
      content: z.string(),
      providerSnapshot: z.null(),
      routeDecision: z.null(),
      status: quickChatMessageStatusSchema,
      errorMessage: z.string().nullable(),
      createdAt: z.number(),
    }).strict(),
    z.object({
      id: z.string().min(1),
      sessionId: z.string().min(1),
      role: z.literal("assistant"),
      content: z.string(),
      providerSnapshot: providerSnapshotSchema.nullable(),
      routeDecision: routeDecisionSchema.nullable(),
      status: quickChatMessageStatusSchema,
      errorMessage: z.string().nullable(),
      createdAt: z.number(),
    }).strict(),
  ]);

export const quickChatAssistantMessageUpdateSchema = z
  .object({
    content: z.string().optional(),
    status: quickChatMessageStatusSchema.optional(),
    errorMessage: z.string().nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Assistant message update cannot be empty",
  });

export type QuickChatAssistantMessageUpdate = z.infer<
  typeof quickChatAssistantMessageUpdateSchema
>;

export const modelSelectionSchema: z.ZodType<ModelSelection> = z.discriminatedUnion(
  "mode",
  [
    z.object({ mode: z.literal("auto") }),
    z.object({ mode: z.literal("manual"), providerId: z.string().min(1) }),
  ],
);

export const taskSnapshotSchema = z.object({
  id: boundedIdentifierSchema,
  projectId: boundedIdentifierSchema,
  title: boundedTextSchema.min(1),
  prompt: boundedTextSchema.min(1),
  status: z.enum([
    "draft",
    "planning",
    "running",
    "awaiting_approval",
    "paused",
    "completed",
    "failed",
    "canceled",
  ]),
  providerSnapshot: providerSnapshotSchema,
  routeDecision: routeDecisionSchema,
  selectionMode: z.enum(["auto", "manual"]),
  executionMode: taskExecutionModeSchema,
  progress: progressSnapshotSchema,
  currentStepId: boundedIdentifierSchema.nullable(),
  activeSince: z.number().nullable(),
  pausedSince: z.number().nullable(),
  pauseReason: z
    .enum(["user", "approval", "backoff", "interrupted"])
    .nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const taskStepSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  completionCriteria: z.string().min(1),
  estimateSeconds: z.number().positive(),
  actualSeconds: z.number().nonnegative().nullable(),
  observedFraction: z.number().min(0).max(1),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
});

const taskEventBase = {
  id: boundedIdentifierSchema,
  taskId: boundedIdentifierSchema,
  at: z.number().finite(),
};
const taskPhaseSchema = z.enum(["planning", "running"]);
const emptyTaskEventPayloadSchema = z.object({}).strict();

export const taskEventSchema: z.ZodType<TaskEvent> =
  z.discriminatedUnion("type", [
    z.object({
      ...taskEventBase,
      type: z.literal("memory_context_loaded"),
      payload: z.object({
        entryCount: z.number().int().min(1).max(5),
        charCount: z.number().int().min(1).max(6_000),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("planning_started"),
      payload: emptyTaskEventPayloadSchema,
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("plan_created"),
      payload: z.object({ title: boundedTextSchema.min(1) }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("step_started"),
      payload: z.object({ stepId: boundedIdentifierSchema }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("step_completed"),
      payload: z.object({
        stepId: boundedIdentifierSchema,
        actualSeconds: z.number().finite().nonnegative(),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("tool_started"),
      payload: z.object({
        callId: boundedIdentifierSchema,
        name: toolNameSchema,
        inputSummary: boundedTextSchema,
        fingerprint: z.string().length(64).optional(),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("tool_completed"),
      payload: z.object({
        callId: boundedIdentifierSchema,
        name: toolNameSchema,
        ok: z.boolean(),
        content: boundedToolResultSchema,
        denied: z.boolean(),
        data: z
          .record(z.string().max(256), taskEventDataSchema)
          .refine((value) => Object.keys(value).length <= 500),
        fingerprint: z.string().length(64).optional(),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("model_output"),
      payload: z.object({ text: boundedTextSchema }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("tool_output"),
      payload: z.object({
        callId: boundedIdentifierSchema,
        stream: z.enum(["stdout", "stderr"]),
        text: boundedTextSchema,
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("app_interrupted"),
      payload: emptyTaskEventPayloadSchema,
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("approval_requested"),
      payload: z.object({
        approvalId: boundedIdentifierSchema,
        summary: boundedTextSchema.min(1),
        reasons: z.array(boundedTextSchema.min(1)).max(100),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("approval_resolved"),
      payload: z.object({
        approvalId: boundedIdentifierSchema,
        decision: z.enum(["allow", "deny"]),
        pausedSeconds: z.number().finite().nonnegative(),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("backoff_started"),
      payload: z.object({
        attempt: z.number().int().positive(),
        delayMs: z.number().finite().nonnegative(),
        phase: taskPhaseSchema,
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("backoff_finished"),
      payload: z.object({
        phase: taskPhaseSchema,
        pausedSeconds: z.number().finite().nonnegative(),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("task_paused"),
      payload: z.object({ phase: taskPhaseSchema }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("task_resumed"),
      payload: z.object({
        phase: taskPhaseSchema,
        pausedSeconds: z.number().finite().nonnegative(),
      }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("task_failed"),
      payload: z.object({ message: boundedTextSchema.min(1) }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("task_retried"),
      payload: z.object({ phase: taskPhaseSchema }).strict(),
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("task_canceled"),
      payload: emptyTaskEventPayloadSchema,
    }).strict(),
    z.object({
      ...taskEventBase,
      type: z.literal("task_completed"),
      payload: emptyTaskEventPayloadSchema,
    }).strict(),
  ]);

export const providerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["kimi", "openai-compatible"]),
  baseUrl: z.string().min(1),
  modelId: z.string().min(1),
  contextLength: z.number().int().positive(),
  headers: z.record(z.string(), z.string()),
  secretRef: z.string().min(1),
  keySuffix: z.string().max(4),
  isDefault: z.boolean(),
  connectionStatus: z.enum(["untested", "connected", "error"]),
  connectionMessage: z.string().nullable(),
  lastTestedAt: z.number().nullable(),
  billingNote: z.string(),
  dashboardUrl: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
