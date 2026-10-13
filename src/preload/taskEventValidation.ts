import type {
  ProviderSnapshot,
  TaskEvent,
  TaskSnapshot,
} from "../shared/domain";
import type { TaskEventEnvelope } from "../shared/ipc";
import type { RouteDecision } from "../shared/taskRouting";
import {
  TOOL_NAME_VALUES,
  type ToolName,
} from "../shared/toolNames";
import {
  MAX_TASK_TEXT_LENGTH,
  MAX_TOOL_RESULT_TEXT_LENGTH,
} from "../shared/taskEventLimits";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TEXT_LENGTH = MAX_TASK_TEXT_LENGTH;
const MAX_COLLECTION_LENGTH = 500;
const MAX_DATA_DEPTH = 20;
const TOOL_NAMES = new Set<ToolName>(TOOL_NAME_VALUES);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    keys.length >= required.length &&
    keys.length <= required.length + optional.length
  );
}

function boundedString(
  value: unknown,
  minimum = 0,
  maximum = MAX_TEXT_LENGTH,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function identifier(value: unknown): value is string {
  return boundedString(value, 1, MAX_IDENTIFIER_LENGTH);
}

function subscriptionIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return identifier(normalized) ? normalized : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegative(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function cloneProviderSnapshot(value: unknown): ProviderSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "providerId",
      "name",
      "kind",
      "baseUrl",
      "modelId",
      "contextLength",
    ]) ||
    !identifier(value.providerId) ||
    !boundedString(value.name, 1) ||
    (value.kind !== "kimi" && value.kind !== "openai-compatible") ||
    !boundedString(value.baseUrl, 1, 4_096) ||
    !boundedString(value.modelId, 1) ||
    !Number.isInteger(value.contextLength) ||
    (value.contextLength as number) <= 0
  ) {
    return null;
  }
  return {
    providerId: value.providerId,
    name: value.name,
    kind: value.kind,
    baseUrl: value.baseUrl,
    modelId: value.modelId,
    contextLength: value.contextLength as number,
  };
}

function cloneRouteDecision(value: unknown): RouteDecision | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "intent",
      "lane",
      "executionMode",
      "confidence",
      "reasonCode",
    ]) ||
    ![
      "simple_qa",
      "simple_text",
      "simple_code",
      "complex_code",
      "media_script",
    ].includes(value.intent as string) ||
    !["light", "premium"].includes(value.lane as string) ||
    !["read_only", "agentic"].includes(value.executionMode as string) ||
    !["high", "medium"].includes(value.confidence as string) ||
    ![
      "simple-question",
      "text-transform",
      "code-explanation",
      "project-change",
      "multi-step-code",
      "media-generation",
      "ambiguous-premium-default",
    ].includes(value.reasonCode as string)
  ) {
    return null;
  }
  return {
    intent: value.intent as RouteDecision["intent"],
    lane: value.lane as RouteDecision["lane"],
    executionMode: value.executionMode as RouteDecision["executionMode"],
    confidence: value.confidence as RouteDecision["confidence"],
    reasonCode: value.reasonCode as RouteDecision["reasonCode"],
  };
}

function cloneTask(value: unknown): TaskSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "projectId",
      "title",
      "prompt",
      "status",
      "providerSnapshot",
      "routeDecision",
      "selectionMode",
      "executionMode",
      "progress",
      "currentStepId",
      "activeSince",
      "pausedSince",
      "pauseReason",
      "createdAt",
      "updatedAt",
    ]) ||
    !identifier(value.id) ||
    !identifier(value.projectId) ||
    !boundedString(value.title, 1) ||
    !boundedString(value.prompt, 1) ||
    ![
      "draft",
      "planning",
      "running",
      "awaiting_approval",
      "paused",
      "completed",
      "failed",
      "canceled",
    ].includes(value.status as string) ||
    !["auto", "manual"].includes(value.selectionMode as string) ||
    !["read_only", "agentic"].includes(value.executionMode as string) ||
    (value.currentStepId !== null && !identifier(value.currentStepId)) ||
    (value.activeSince !== null && !finiteNumber(value.activeSince)) ||
    (value.pausedSince !== null && !finiteNumber(value.pausedSince)) ||
    ![null, "user", "approval", "backoff", "interrupted"].includes(
      value.pauseReason as string | null,
    ) ||
    !finiteNumber(value.createdAt) ||
    !finiteNumber(value.updatedAt)
  ) {
    return null;
  }
  const providerSnapshot = cloneProviderSnapshot(value.providerSnapshot);
  const routeDecision = cloneRouteDecision(value.routeDecision);
  const progress = value.progress;
  if (
    providerSnapshot === null ||
    routeDecision === null ||
    !isRecord(progress) ||
    !hasExactKeys(progress, [
      "percent",
      "elapsedSeconds",
      "remainingSeconds",
      "estimationState",
    ]) ||
    !finiteNumber(progress.percent) ||
    progress.percent < 0 ||
    progress.percent > 100 ||
    !nonnegative(progress.elapsedSeconds) ||
    (progress.remainingSeconds !== null &&
      !nonnegative(progress.remainingSeconds)) ||
    !["ready", "recalculating", "paused"].includes(
      progress.estimationState as string,
    )
  ) {
    return null;
  }
  return {
    id: value.id,
    projectId: value.projectId,
    title: value.title,
    prompt: value.prompt,
    status: value.status as TaskSnapshot["status"],
    providerSnapshot,
    routeDecision,
    selectionMode: value.selectionMode as TaskSnapshot["selectionMode"],
    executionMode: value.executionMode as TaskSnapshot["executionMode"],
    progress: {
      percent: progress.percent,
      elapsedSeconds: progress.elapsedSeconds,
      remainingSeconds: progress.remainingSeconds as number | null,
      estimationState:
        progress.estimationState as TaskSnapshot["progress"]["estimationState"],
    },
    currentStepId: value.currentStepId as string | null,
    activeSince: value.activeSince as number | null,
    pausedSince: value.pausedSince as number | null,
    pauseReason: value.pauseReason as TaskSnapshot["pauseReason"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function cloneData(
  value: unknown,
  depth = 0,
): unknown | undefined {
  if (depth > MAX_DATA_DEPTH) return undefined;
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    return boundedString(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_LENGTH) return undefined;
    const output: unknown[] = [];
    for (const item of value) {
      const cloned = cloneData(item, depth + 1);
      if (cloned === undefined) return undefined;
      output.push(cloned);
    }
    return output;
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length > MAX_COLLECTION_LENGTH ||
    entries.some(([key]) => key.length > MAX_IDENTIFIER_LENGTH)
  ) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const cloned = cloneData(item, depth + 1);
    if (cloned === undefined) return undefined;
    output[key] = cloned;
  }
  return output;
}

function cloneTaskEvent(value: unknown): TaskEvent | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "taskId", "type", "at", "payload"]) ||
    !identifier(value.id) ||
    !identifier(value.taskId) ||
    typeof value.type !== "string" ||
    !finiteNumber(value.at) ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  const payload = value.payload;
  let clonedPayload: Record<string, unknown> | null = null;
  switch (value.type) {
    case "planning_started":
    case "app_interrupted":
    case "task_canceled":
    case "task_completed":
      if (hasExactKeys(payload, [])) clonedPayload = {};
      break;
    case "plan_created":
      if (
        hasExactKeys(payload, ["title"]) &&
        boundedString(payload.title, 1)
      ) clonedPayload = { title: payload.title };
      break;
    case "step_started":
      if (
        hasExactKeys(payload, ["stepId"]) &&
        identifier(payload.stepId)
      ) clonedPayload = { stepId: payload.stepId };
      break;
    case "step_completed":
      if (
        hasExactKeys(payload, ["stepId", "actualSeconds"]) &&
        identifier(payload.stepId) &&
        nonnegative(payload.actualSeconds)
      ) {
        clonedPayload = {
          stepId: payload.stepId,
          actualSeconds: payload.actualSeconds,
        };
      }
      break;
    case "tool_started":
      if (
        hasExactKeys(
          payload,
          ["callId", "name", "inputSummary"],
          ["fingerprint"],
        ) &&
        identifier(payload.callId) &&
        TOOL_NAMES.has(payload.name as ToolName) &&
        boundedString(payload.inputSummary) &&
        (payload.fingerprint === undefined ||
          (typeof payload.fingerprint === "string" &&
            payload.fingerprint.length === 64))
      ) {
        clonedPayload = {
          callId: payload.callId,
          name: payload.name,
          inputSummary: payload.inputSummary,
          ...(payload.fingerprint === undefined
            ? {}
            : { fingerprint: payload.fingerprint }),
        };
      }
      break;
    case "tool_completed": {
      const data = cloneData(payload.data);
      if (
        hasExactKeys(
          payload,
          ["callId", "name", "ok", "content", "denied", "data"],
          ["fingerprint"],
        ) &&
        identifier(payload.callId) &&
        TOOL_NAMES.has(payload.name as ToolName) &&
        typeof payload.ok === "boolean" &&
        boundedString(
          payload.content,
          0,
          MAX_TOOL_RESULT_TEXT_LENGTH,
        ) &&
        typeof payload.denied === "boolean" &&
        isRecord(payload.data) &&
        isRecord(data) &&
        (payload.fingerprint === undefined ||
          (typeof payload.fingerprint === "string" &&
            payload.fingerprint.length === 64))
      ) {
        clonedPayload = {
          callId: payload.callId,
          name: payload.name,
          ok: payload.ok,
          content: payload.content,
          denied: payload.denied,
          data,
          ...(payload.fingerprint === undefined
            ? {}
            : { fingerprint: payload.fingerprint }),
        };
      }
      break;
    }
    case "model_output":
      if (
        hasExactKeys(payload, ["text"]) &&
        boundedString(payload.text)
      ) clonedPayload = { text: payload.text };
      break;
    case "tool_output":
      if (
        hasExactKeys(payload, ["callId", "stream", "text"]) &&
        identifier(payload.callId) &&
        (payload.stream === "stdout" || payload.stream === "stderr") &&
        boundedString(payload.text)
      ) {
        clonedPayload = {
          callId: payload.callId,
          stream: payload.stream,
          text: payload.text,
        };
      }
      break;
    case "approval_requested":
      if (
        hasExactKeys(
          payload,
          ["approvalId", "summary", "reasons"],
          ["requestDigest"],
        ) &&
        identifier(payload.approvalId) &&
        (payload.requestDigest === undefined ||
          (typeof payload.requestDigest === "string" &&
            /^[a-f0-9]{64}$/.test(payload.requestDigest))) &&
        boundedString(payload.summary, 1) &&
        Array.isArray(payload.reasons) &&
        payload.reasons.length <= 100 &&
        payload.reasons.every((reason) => boundedString(reason, 1))
      ) {
        clonedPayload = {
          approvalId: payload.approvalId,
          ...(payload.requestDigest === undefined
            ? {}
            : { requestDigest: payload.requestDigest }),
          summary: payload.summary,
          reasons: [...payload.reasons],
        };
      }
      break;
    case "approval_resolved":
      if (
        hasExactKeys(
          payload,
          ["approvalId", "decision", "pausedSeconds"],
          ["requestDigest"],
        ) &&
        identifier(payload.approvalId) &&
        (payload.requestDigest === undefined ||
          (typeof payload.requestDigest === "string" &&
            /^[a-f0-9]{64}$/.test(payload.requestDigest))) &&
        (payload.decision === "allow" || payload.decision === "deny") &&
        nonnegative(payload.pausedSeconds)
      ) {
        clonedPayload = {
          approvalId: payload.approvalId,
          ...(payload.requestDigest === undefined
            ? {}
            : { requestDigest: payload.requestDigest }),
          decision: payload.decision,
          pausedSeconds: payload.pausedSeconds,
        };
      }
      break;
    case "backoff_started":
      if (
        hasExactKeys(payload, ["attempt", "delayMs", "phase"]) &&
        Number.isInteger(payload.attempt) &&
        (payload.attempt as number) > 0 &&
        nonnegative(payload.delayMs) &&
        (payload.phase === "planning" || payload.phase === "running")
      ) {
        clonedPayload = {
          attempt: payload.attempt,
          delayMs: payload.delayMs,
          phase: payload.phase,
        };
      }
      break;
    case "backoff_finished":
    case "task_resumed":
      if (
        hasExactKeys(payload, ["phase", "pausedSeconds"]) &&
        (payload.phase === "planning" || payload.phase === "running") &&
        nonnegative(payload.pausedSeconds)
      ) {
        clonedPayload = {
          phase: payload.phase,
          pausedSeconds: payload.pausedSeconds,
        };
      }
      break;
    case "task_paused":
    case "task_retried":
      if (
        hasExactKeys(payload, ["phase"]) &&
        (payload.phase === "planning" || payload.phase === "running")
      ) clonedPayload = { phase: payload.phase };
      break;
    case "task_failed":
      if (
        hasExactKeys(payload, ["message"]) &&
        boundedString(payload.message, 1)
      ) clonedPayload = { message: payload.message };
      break;
    default:
      return null;
  }
  if (clonedPayload === null) return null;
  return {
    id: value.id,
    taskId: value.taskId,
    type: value.type,
    at: value.at,
    payload: clonedPayload,
  } as unknown as TaskEvent;
}

export function cloneTaskEventEnvelope(
  value: unknown,
): TaskEventEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["subscriptionId", "task"], ["event"])
  ) {
    return null;
  }
  const subscriptionId = subscriptionIdentifier(value.subscriptionId);
  const task = cloneTask(value.task);
  if (subscriptionId === null || task === null) {
    return null;
  }
  if (value.event === undefined) {
    return { subscriptionId, task };
  }
  const event = cloneTaskEvent(value.event);
  if (event === null) return null;
  return {
    subscriptionId,
    task,
    event,
  };
}
