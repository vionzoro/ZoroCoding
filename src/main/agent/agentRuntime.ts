import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runReviewerChain } from "../approval/reviewerChain";
import type { ReviewerChainOptions } from "../approval/types";
import { classifyApprovalTier } from "../../shared/approvalTier";

import type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
  ModelToolCall,
} from "../models/types";
import { ModelProviderError } from "../models/openAiCompatibleProvider";
import type { TaskRepository } from "../persistence/taskRepository";
import { computeProgress } from "../tasks/progressEngine";
import type {
  PermissionDecision,
  ProjectSummary,
  ProviderSnapshot,
  TaskEvent,
  TaskSnapshot,
  TaskStep,
  ToolCall,
  ToolOperation,
  ToolResult,
} from "../../shared/domain";
import {
  TOOL_NAME_VALUES,
  type ToolName,
} from "../../shared/toolNames";
import { summarizeTaskToolResult } from "../../shared/taskEventLimits";
import type {
  RouteDecision,
  TaskExecutionMode,
} from "../../shared/taskRouting";
import {
  PLAN_REPAIR_PROMPT,
  PLANNING_SYSTEM_PROMPT,
  READ_ONLY_PLANNING_SYSTEM_PROMPT,
  parseTaskPlan,
  type ParsedTaskPlan,
} from "./planParser";

const MAX_MODEL_RETRIES = 3;
const MAX_TOOL_TURNS_PER_STEP = 24;
const LIVE_OUTPUT_FLUSH_MS = 150;
const LIVE_OUTPUT_FLUSH_CHARS = 8 * 1024;
const MAX_LIVE_OUTPUT_CHARS = 64 * 1024;
const TOOL_NAMES = new Set<ToolName>(TOOL_NAME_VALUES);
const AGENTIC_SYSTEM =
  "你是 ZoroCoding 本地编程代理。只在当前步骤范围内工作，使用工具读取、修改和验证项目；完成后简洁说明结果。";
const READ_ONLY_SYSTEM =
  "你是 ZoroCoding 项目只读助手。你可以列出、搜索和读取当前项目中的文件并回答问题；不得修改文件、运行命令或声称已执行这些操作。";

export interface RuntimeModelGateway {
  stream(
    providerId: string,
    request: ModelRequest,
  ): AsyncIterable<ModelEvent>;
}

export interface RuntimeToolRegistry {
  definitions: ModelToolDefinition[];
  execute(
    call: ToolCall,
    onOutput?: (output: {
      stream: "stdout" | "stderr";
      text: string;
    }) => void,
  ): Promise<ToolResult>;
  cancelAll(): Promise<void>;
}

export type RuntimeApprovalRequester = (
  decision: PermissionDecision,
  operation: ToolOperation,
) => Promise<boolean>;

export interface AgentRuntimeOptions {
  repository: TaskRepository;
  modelGateway: RuntimeModelGateway;
  createTools: (
    projectRoot: string,
    executionMode: TaskExecutionMode,
    requestApproval: RuntimeApprovalRequester,
  ) => RuntimeToolRegistry;
  now?: () => number;
  sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  createId?: () => string;
  recoverInterrupted?: boolean;
  storageCancellationTimeoutMs?: number;
  approvalReview?: ReviewerChainOptions;
}

export interface CreateTaskInput {
  project: ProjectSummary;
  prompt: string;
  provider: ProviderSnapshot;
  routeDecision: RouteDecision;
  selectionMode: "auto" | "manual";
}

export type ApprovalResolution = "allow" | "deny";
export type TaskListener = (
  snapshot: TaskSnapshot,
  event?: TaskEvent,
) => void;

interface PendingApproval {
  approvalId: string;
  controller: AbortController;
  phase: "review" | "dialog";
  resolve: (allowed: boolean) => void;
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "AI 任务执行时发生未知错误。";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof ModelProviderError &&
    error.failure.retryable
  );
}

function parseToolCall(call: ModelToolCall): ToolCall {
  if (!TOOL_NAMES.has(call.name as ToolName)) {
    throw new Error(`模型请求了未知工具：${call.name}`);
  }
  const parsed = JSON.parse(call.arguments) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(`工具 ${call.name} 的参数必须是 JSON 对象。`);
  }
  return {
    id: call.id,
    name: call.name as ToolName,
    arguments: parsed as Record<string, unknown>,
  };
}

function readOnlyDeniedToolCall(
  executionMode: TaskExecutionMode,
  modelCall: ModelToolCall,
): { call: ToolCall; result: ToolResult } | null {
  if (
    executionMode !== "read_only" ||
    (modelCall.name !== "write_file" &&
      modelCall.name !== "run_shell")
  ) {
    return null;
  }
  const call: ToolCall = {
    id: modelCall.id,
    name: modelCall.name,
    arguments: {},
  };
  return {
    call,
    result: {
      callId: call.id,
      name: call.name,
      ok: false,
      denied: true,
      content:
        call.name === "run_shell"
          ? "只读任务不允许运行终端命令。"
          : "只读任务不允许修改文件。",
    },
  };
}

function summarizeToolInput(call: ToolCall): string {
  switch (call.name) {
    case "list_files":
      return typeof call.arguments.path === "string"
        ? call.arguments.path
        : ".";
    case "read_file":
    case "write_file":
      return typeof call.arguments.path === "string"
        ? call.arguments.path
        : call.name;
    case "search_files":
      return typeof call.arguments.query === "string"
        ? call.arguments.query
        : call.name;
    case "run_shell":
      return typeof call.arguments.command === "string"
        ? call.arguments.command
        : call.name;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function toolFingerprint(call: ToolCall): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: call.name,
        arguments: stableValue(call.arguments),
      }),
    )
    .digest("hex");
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_LIVE_OUTPUT_CHARS
    ? combined
    : combined.slice(-MAX_LIVE_OUTPUT_CHARS);
}

export class AgentRuntime {
  private readonly repository: TaskRepository;
  private readonly modelGateway: RuntimeModelGateway;
  private readonly createTools: AgentRuntimeOptions["createTools"];
  private readonly now: () => number;
  private readonly sleep: NonNullable<AgentRuntimeOptions["sleep"]>;
  private readonly createId: () => string;
  private readonly listeners = new Set<TaskListener>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeTools = new Map<string, RuntimeToolRegistry>();
  private readonly recoveryResults = new Map<
    string,
    Map<string, ToolResult>
  >();
  private storageInterrupted = false;
  private readonly storageCancellationTimeoutMs: number;
  private readonly approvalReview?: ReviewerChainOptions;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AgentRuntimeOptions) {
    this.approvalReview = options.approvalReview;
    this.repository = options.repository;
    this.modelGateway = options.modelGateway;
    this.createTools = options.createTools;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.createId = options.createId ?? randomUUID;
    this.storageCancellationTimeoutMs = options.storageCancellationTimeoutMs ?? 2_000;
    if (options.recoverInterrupted !== false) {
      for (const task of this.repository.recoverInterrupted(this.now())) {
        this.emit(task);
      }
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskSnapshot> {
    const now = this.now();
    this.repository.upsertProject({
      ...input.project,
      lastOpenedAt: now,
    });
    const snapshot: TaskSnapshot = {
      id: this.createId(),
      projectId: input.project.id,
      title: input.prompt.trim().slice(0, 60) || "新任务",
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
    this.repository.create(snapshot);
    this.repository.appendMessage(
      snapshot.id,
      { role: "user", content: input.prompt },
      now,
      this.createId(),
    );
    this.emit(snapshot);
    this.enqueue(snapshot.id);
    return snapshot;
  }

  async pause(taskId: string): Promise<void> {
    const snapshot = this.requireTask(taskId);
    const isBackoffPause =
      snapshot.status === "paused" && snapshot.pauseReason === "backoff";
    if (
      !isBackoffPause &&
      !["planning", "running", "awaiting_approval"].includes(snapshot.status)
    ) {
      return;
    }
    const phase =
      this.repository.steps(taskId).length === 0 ? "planning" : "running";
    this.appendEvent(taskId, {
      type: "task_paused",
      payload: { phase },
    });
    this.abortControllers.get(taskId)?.abort();
    this.abortApproval(taskId);
    await this.activeTools.get(taskId)?.cancelAll();
  }

  async resume(taskId: string): Promise<void> {
    const snapshot = this.requireTask(taskId);
    if (snapshot.status !== "paused") {
      return;
    }
    const phase =
      this.repository.steps(taskId).length === 0 ? "planning" : "running";
    const pausedSeconds = Math.max(
      0,
      Math.floor((this.now() - (snapshot.pausedSince ?? this.now())) / 1_000),
    );
    this.captureRecoveryResults(taskId);
    this.appendEvent(taskId, {
      type: "task_resumed",
      payload: { phase, pausedSeconds },
    });
    this.enqueue(taskId);
  }

  async retry(taskId: string): Promise<void> {
    const snapshot = this.requireTask(taskId);
    if (snapshot.status !== "failed") {
      throw new Error("只有执行失败的任务可以重试。");
    }
    const steps = this.repository.steps(taskId);
    const failedStep = steps.find((step) => step.status === "failed");
    if (failedStep !== undefined) {
      this.repository.updateStep({
        ...failedStep,
        status: "pending",
        actualSeconds: null,
      });
    }
    const phase = steps.length === 0 ? "planning" : "running";
    this.captureRecoveryResults(taskId);
    this.appendEvent(taskId, {
      type: "task_retried",
      payload: { phase },
    });
    this.refreshProgress(taskId);
    this.enqueue(taskId);
  }

  async addMessage(taskId: string, content: string): Promise<void> {
    const snapshot = this.requireTask(taskId);
    if (["completed", "canceled"].includes(snapshot.status)) {
      throw new Error("已结束的任务不能继续补充要求。");
    }
    const normalized = content.trim();
    if (normalized.length === 0) {
      throw new Error("补充要求不能为空。");
    }
    this.repository.appendMessage(
      taskId,
      { role: "user", content: normalized },
      this.now(),
      this.createId(),
    );
    const next = {
      ...snapshot,
      updatedAt: this.now(),
    };
    this.repository.saveSnapshot(next);
    this.emit(next);
  }

  async cancel(taskId: string): Promise<void> {
    const snapshot = this.requireTask(taskId);
    if (["completed", "failed", "canceled"].includes(snapshot.status)) {
      return;
    }
    this.appendEvent(taskId, {
      type: "task_canceled",
      payload: {},
    });
    this.abortControllers.get(taskId)?.abort();
    this.abortApproval(taskId);
    await this.activeTools.get(taskId)?.cancelAll();
  }

  async pauseActiveTasks(): Promise<void> {
    const active = this.repository
      .list()
      .filter((task) =>
        ["planning", "running", "awaiting_approval"].includes(task.status) ||
        (task.status === "paused" && task.pauseReason === "backoff"),
      );
    await Promise.all(active.map((task) => this.pause(task.id)));
  }

  async interruptForStorageLoss(): Promise<void> {
    this.storageInterrupted = true;
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    for (const approval of this.pendingApprovals.values()) {
      approval.controller.abort();
      approval.resolve(false);
    }
    this.pendingApprovals.clear();
    await Promise.allSettled(
      [...this.activeTools.values()].map((tools) =>
        Promise.race([
          tools.cancelAll(),
          new Promise<void>((resolve) => setTimeout(resolve, this.storageCancellationTimeoutMs)),
        ]),
      ),
    );
  }

  async resolveApproval(
    taskId: string,
    resolution: ApprovalResolution,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(taskId);
    if (
      pending === undefined ||
      pending.phase !== "dialog" ||
      this.storageInterrupted
    ) {
      throw new Error("该任务当前没有等待处理的批准请求。");
    }
    const snapshot = this.requireTask(taskId);
    if (snapshot.status !== "awaiting_approval") {
      throw new Error("该任务当前没有等待处理的批准请求。");
    }
    const pausedSeconds = Math.max(
      0,
      Math.floor((this.now() - (snapshot.pausedSince ?? this.now())) / 1_000),
    );
    this.appendEvent(taskId, {
      type: "approval_resolved",
      payload: {
        approvalId: pending.approvalId,
        decision: resolution,
        pausedSeconds,
      },
    });
    this.pendingApprovals.delete(taskId);
    pending.controller.abort();
    pending.resolve(resolution === "allow");
  }

  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitForIdle(): Promise<void> {
    await this.queue;
  }

  private enqueue(taskId: string): void {
    const operation = this.queue
      .catch(() => {})
      .then(() => this.executeSafely(taskId));
    this.queue = operation.catch(() => {});
  }

  private async executeSafely(taskId: string): Promise<void> {
    try {
      this.throwIfStorageInterrupted();
      await this.executeTask(taskId);
    } catch (error) {
      const snapshot = this.repository.get(taskId);
      if (
        snapshot === null ||
        ["paused", "canceled", "failed", "completed"].includes(snapshot.status)
      ) {
        return;
      }
      if (isAbort(error)) {
        return;
      }
      this.markCurrentStepFailed(taskId);
      this.appendEvent(taskId, {
        type: "task_failed",
        payload: { message: errorMessage(error) },
      });
    } finally {
      this.activeTools.delete(taskId);
      this.abortControllers.delete(taskId);
    }
  }

  private async executeTask(taskId: string): Promise<void> {
    let snapshot = this.requireTask(taskId);
    if (snapshot.status === "draft") {
      this.appendEvent(taskId, {
        type: "planning_started",
        payload: {},
      });
      snapshot = this.requireTask(taskId);
    }

    let steps = this.repository.steps(taskId);
    if (steps.length === 0) {
      if (snapshot.status !== "planning") {
        return;
      }
      await this.createPlan(taskId);
      steps = this.repository.steps(taskId);
    }
    if (this.requireTask(taskId).status !== "running") {
      return;
    }

    const project = this.repository.getProject(snapshot.projectId);
    if (project === null) {
      throw new Error("任务关联的本地项目不存在。");
    }
    const tools = this.createTools(
      project.canonicalPath,
      snapshot.executionMode,
      (decision, operation) =>
        this.requestApproval(taskId, decision, operation),
    );
    this.activeTools.set(taskId, tools);

    for (const step of steps) {
      const current = this.requireTask(taskId);
      if (current.status !== "running") {
        return;
      }
      if (step.status === "completed" || step.status === "skipped") {
        continue;
      }
      const startedAt = this.now();
      const runningStep: TaskStep = {
        ...step,
        status: "running",
        observedFraction: Math.max(step.observedFraction, 0.05),
      };
      this.repository.updateStep(runningStep);
      this.appendEvent(taskId, {
        type: "step_started",
        payload: { stepId: step.id },
      });
      this.refreshProgress(taskId);

      await this.runStep(taskId, runningStep, tools);
      if (this.requireTask(taskId).status !== "running") {
        return;
      }
      const actualSeconds = Math.max(
        0,
        Math.round((this.now() - startedAt) / 1_000),
      );
      this.repository.updateStep({
        ...runningStep,
        status: "completed",
        observedFraction: 1,
        actualSeconds,
      });
      this.appendEvent(taskId, {
        type: "step_completed",
        payload: { stepId: step.id, actualSeconds },
      });
      this.refreshProgress(taskId);
    }

    if (
      this.repository
        .steps(taskId)
        .every((step) =>
          ["completed", "skipped"].includes(step.status),
        )
    ) {
      this.appendEvent(taskId, {
        type: "task_completed",
        payload: {},
      });
    }
  }

  private async createPlan(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    const planningMessages: ModelMessage[] = [
      {
        role: "system",
        content:
          task.executionMode === "read_only"
            ? READ_ONLY_PLANNING_SYSTEM_PROMPT
            : PLANNING_SYSTEM_PROMPT,
      },
      { role: "user", content: task.prompt },
    ];
    let planText = await this.collectText(
      taskId,
      "planning",
      planningMessages,
      [],
    );
    this.throwIfStorageInterrupted();
    let parsed: ParsedTaskPlan;
    try {
      parsed = parseTaskPlan(planText);
    } catch {
      planningMessages.push(
        { role: "assistant", content: planText },
        { role: "user", content: PLAN_REPAIR_PROMPT },
      );
      planText = await this.collectText(
        taskId,
        "planning",
        planningMessages,
        [],
      );
      this.throwIfStorageInterrupted();
      parsed = parseTaskPlan(planText);
    }

    const steps: TaskStep[] = parsed.steps.map((step, index) => ({
      id: this.createId(),
      taskId,
      order: index,
      title: step.title,
      completionCriteria: step.completionCriteria,
      estimateSeconds: step.estimateSeconds,
      actualSeconds: null,
      observedFraction: 0,
      status: "pending",
    }));
    this.repository.replaceSteps(taskId, steps);
    this.repository.appendMessage(
      taskId,
      { role: "assistant", content: planText },
      this.now(),
      this.createId(),
    );
    this.appendEvent(taskId, {
      type: "plan_created",
      payload: { title: parsed.title },
    });
    this.refreshProgress(taskId);
  }

  private async runStep(
    taskId: string,
    step: TaskStep,
    tools: RuntimeToolRegistry,
  ): Promise<void> {
    const task = this.requireTask(taskId);
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          task.executionMode === "read_only"
            ? READ_ONLY_SYSTEM
            : AGENTIC_SYSTEM,
      },
      {
        role: "user",
        content: [
          `总任务：${task.prompt}`,
          `当前步骤：${step.title}`,
          `完成条件：${step.completionCriteria}`,
        ].join("\n"),
      },
    ];
    const persisted = this.repository.messages(taskId);
    const knownMessageIds = new Set<string>();
    const initialUser = persisted.find(
      (item) =>
        item.message.role === "user" &&
        item.message.content === task.prompt,
    );
    if (initialUser !== undefined) {
      knownMessageIds.add(initialUser.id);
    }
    const planMessageIndex = persisted.findIndex(
      (item) =>
        item.message.role === "assistant" &&
        typeof item.message.content === "string" &&
        (() => {
          try {
            parseTaskPlan(item.message.content);
            return true;
          } catch {
            return false;
          }
        })(),
    );
    if (planMessageIndex >= 0) {
      knownMessageIds.add(persisted[planMessageIndex].id);
      for (const [index, item] of persisted.entries()) {
        const isSupplementBeforePlan =
          index < planMessageIndex &&
          item.message.role === "user" &&
          !knownMessageIds.has(item.id);
        if (index > planMessageIndex || isSupplementBeforePlan) {
          messages.push(item.message);
          knownMessageIds.add(item.id);
        }
      }
    }

    const appendNewUserMessages = (): number => {
      let appended = 0;
      for (const item of this.repository.messages(taskId)) {
        if (knownMessageIds.has(item.id) || item.message.role !== "user") {
          continue;
        }
        knownMessageIds.add(item.id);
        messages.push(item.message);
        appended += 1;
      }
      return appended;
    };

    for (let turn = 0; turn < MAX_TOOL_TURNS_PER_STEP; turn += 1) {
      appendNewUserMessages();
      const modelEvents = await this.collectEvents(taskId, "running", {
        messages,
        tools: tools.definitions,
      });
      this.throwIfStorageInterrupted();
      let text = "";
      const modelCalls: ModelToolCall[] = [];
      for (const event of modelEvents) {
        if (event.type === "text_delta") {
          text += event.text;
        } else if (event.type === "tool_call") {
          modelCalls.push(event.call);
        }
      }

      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: text || null,
        toolCalls: modelCalls.length === 0 ? undefined : modelCalls,
      };
      messages.push(assistantMessage);
      this.repository.appendMessage(
        taskId,
        assistantMessage,
        this.now(),
        this.createId(),
      );

      if (modelCalls.length === 0) {
        if (appendNewUserMessages() > 0) {
          continue;
        }
        return;
      }

      for (const modelCall of modelCalls) {
        const denied = readOnlyDeniedToolCall(
          task.executionMode,
          modelCall,
        );
        const call = denied?.call ?? parseToolCall(modelCall);
        const result =
          this.completedToolResult(taskId, call) ??
          (await this.executeTool(
            taskId,
            call,
            tools,
            denied?.result,
          ));
        const toolMessage: ModelMessage = {
          role: "tool",
          toolCallId: call.id,
          content: result.content,
        };
        messages.push(toolMessage);
        this.repository.appendMessage(
          taskId,
          toolMessage,
          this.now(),
          this.createId(),
        );
      }
    }
    throw new Error("当前步骤的模型工具调用次数超过安全上限。");
  }

  private async executeTool(
    taskId: string,
    call: ToolCall,
    tools: RuntimeToolRegistry,
    deniedResult?: ToolResult,
  ): Promise<ToolResult> {
    this.appendEvent(taskId, {
      type: "tool_started",
      payload: {
        callId: call.id,
        name: call.name,
        inputSummary: summarizeToolInput(call),
        fingerprint: toolFingerprint(call),
      },
    });
    this.bumpCurrentStep(taskId, 0.12);
    const pendingOutput = { stdout: "", stderr: "" };
    let lastOutputFlushAt = this.now();
    let outputTimer: ReturnType<typeof setTimeout> | null = null;
    const flushOutput = () => {
      if (this.storageInterrupted) {
        pendingOutput.stdout = "";
        pendingOutput.stderr = "";
        return;
      }
      if (outputTimer !== null) {
        clearTimeout(outputTimer);
        outputTimer = null;
      }
      if (this.repository.get(taskId)?.status !== "running") {
        pendingOutput.stdout = "";
        pendingOutput.stderr = "";
        return;
      }
      let emitted = false;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = pendingOutput[stream];
        if (text.length === 0) {
          continue;
        }
        pendingOutput[stream] = "";
        emitted = true;
        this.appendEvent(taskId, {
          type: "tool_output",
          payload: { callId: call.id, stream, text },
        });
      }
      if (emitted) {
        lastOutputFlushAt = this.now();
        this.bumpCurrentStep(taskId, 0.03);
      }
    };
    const scheduleOutputFlush = () => {
      if (outputTimer !== null) {
        return;
      }
      outputTimer = setTimeout(flushOutput, LIVE_OUTPUT_FLUSH_MS);
    };
    let result: ToolResult;
    try {
      result =
        deniedResult ??
        (await tools.execute(call, (output) => {
          pendingOutput[output.stream] = appendBounded(
            pendingOutput[output.stream],
            output.text,
          );
          if (
            this.now() - lastOutputFlushAt >= LIVE_OUTPUT_FLUSH_MS ||
            pendingOutput[output.stream].length >= LIVE_OUTPUT_FLUSH_CHARS
          ) {
            flushOutput();
          } else {
            scheduleOutputFlush();
          }
        }));
      this.throwIfStorageInterrupted();
    } finally {
      flushOutput();
    }
    this.appendEvent(taskId, {
      type: "tool_completed",
      payload: {
        callId: result.callId,
        name: result.name,
        ok: result.ok,
        content: summarizeTaskToolResult(result.content),
        denied: result.denied ?? false,
        data: result.data ?? {},
        fingerprint: toolFingerprint(call),
      },
    });
    this.bumpCurrentStep(taskId, 0.1);
    this.persistFileChange(taskId, result);
    return result;
  }

  private completedToolResult(
    taskId: string,
    call: ToolCall,
  ): ToolResult | null {
    const event = this.repository
      .events(taskId)
      .find(
        (candidate) =>
          candidate.type === "tool_completed" &&
          candidate.payload.callId === call.id,
      );
    if (event?.type === "tool_completed") {
      return {
        callId: call.id,
        name: event.payload.name,
        ok: event.payload.ok,
        content: event.payload.content,
        denied: event.payload.denied,
        data: event.payload.data,
      };
    }
    const recovered = this.recoveryResults
      .get(taskId)
      ?.get(toolFingerprint(call));
    if (recovered === undefined) {
      return null;
    }
    this.recoveryResults.get(taskId)?.delete(toolFingerprint(call));
    return { ...recovered, callId: call.id };
  }

  private persistFileChange(taskId: string, result: ToolResult): void {
    if (result.name !== "write_file" || result.data === undefined) {
      return;
    }
    const project = this.repository.getProject(
      this.requireTask(taskId).projectId,
    );
    const path = result.data.path;
    const beforeHash = result.data.beforeSha256;
    const afterHash = result.data.afterSha256;
    if (
      project === null ||
      typeof path !== "string" ||
      typeof beforeHash !== "string" ||
      typeof afterHash !== "string"
    ) {
      return;
    }
    this.repository.appendFileChange({
      taskId,
      canonicalPath: resolve(project.canonicalPath, path),
      beforeHash,
      afterHash,
      patch: result.content,
      createdAt: this.now(),
    });
  }

  private async collectText(
    taskId: string,
    phase: "planning" | "running",
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
  ): Promise<string> {
    const events = await this.collectEvents(taskId, phase, {
      messages,
      tools,
    });
    return events
      .filter(
        (event): event is Extract<ModelEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.text)
      .join("");
  }

  private async collectEvents(
    taskId: string,
    phase: "planning" | "running",
    request: Omit<ModelRequest, "signal">,
  ): Promise<ModelEvent[]> {
    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt += 1) {
      const controller = new AbortController();
      this.abortControllers.set(taskId, controller);
      let pendingModelOutput = "";
      let lastModelFlushAt = this.now();
      const flushModelOutput = () => {
        if (this.storageInterrupted) {
          pendingModelOutput = "";
          return;
        }
        if (pendingModelOutput.length === 0) {
          return;
        }
        const status = this.repository.get(taskId)?.status;
        if (status !== "planning" && status !== "running") {
          pendingModelOutput = "";
          return;
        }
        const text = pendingModelOutput;
        pendingModelOutput = "";
        lastModelFlushAt = this.now();
        this.appendEvent(taskId, {
          type: "model_output",
          payload: { text },
        });
        if (phase === "running") {
          this.bumpCurrentStep(taskId, 0.01);
        }
      };
      try {
        const events: ModelEvent[] = [];
        for await (const event of this.modelGateway.stream(
          this.requireTask(taskId).providerSnapshot.providerId,
          { ...request, signal: controller.signal },
        )) {
          events.push(event);
          if (event.type === "text_delta") {
            pendingModelOutput = appendBounded(
              pendingModelOutput,
              event.text,
            );
            if (
              this.now() - lastModelFlushAt >= LIVE_OUTPUT_FLUSH_MS ||
              pendingModelOutput.length >= LIVE_OUTPUT_FLUSH_CHARS
            ) {
              flushModelOutput();
            }
          }
        }
        flushModelOutput();
        return events;
      } catch (error) {
        flushModelOutput();
        const status = this.repository.get(taskId)?.status;
        if (
          isAbort(error) ||
          status === "paused" ||
          status === "canceled"
        ) {
          throw error;
        }
        if (!isRetryable(error) || attempt === MAX_MODEL_RETRIES) {
          throw error;
        }
        const serverDelay =
          error instanceof ModelProviderError
            ? error.failure.retryAfterMs
            : null;
        const delayMs = Math.min(
          30_000,
          Math.max(0, serverDelay ?? 1_000 * 2 ** attempt),
        );
        const pauseStartedAt = this.now();
        this.appendEvent(taskId, {
          type: "backoff_started",
          payload: {
            attempt: attempt + 1,
            delayMs,
            phase,
          },
        });
        await this.sleep(delayMs, controller.signal);
        if (this.requireTask(taskId).status !== "paused") {
          throw new Error("模型重试等待状态异常。");
        }
        this.appendEvent(taskId, {
          type: "backoff_finished",
          payload: {
            phase,
            pausedSeconds: Math.max(
              0,
              Math.floor((this.now() - pauseStartedAt) / 1_000),
            ),
          },
        });
      } finally {
        if (this.abortControllers.get(taskId) === controller) {
          this.abortControllers.delete(taskId);
        }
      }
    }
    throw new Error("模型重试次数已耗尽。");
  }

  private abortApproval(taskId: string): void {
    const pending = this.pendingApprovals.get(taskId);
    if (pending === undefined) return;
    this.pendingApprovals.delete(taskId);
    pending.controller.abort();
    pending.resolve(false);
  }

  private requestApproval(
    taskId: string,
    decision: PermissionDecision,
    operation: ToolOperation,
  ): Promise<boolean> {
    if (
      this.storageInterrupted ||
      this.requireTask(taskId).status !== "running"
    ) {
      return Promise.resolve(false);
    }
    if (this.pendingApprovals.has(taskId)) {
      throw new Error("任务已有一个等待处理的批准请求。");
    }
    const approvalId = this.createId();
    const controller = new AbortController();
    const summary = decision.summary;
    const reasons = [...decision.reasons];
    return new Promise<boolean>((resolveApproval) => {
      const pending: PendingApproval = {
        approvalId,
        controller,
        phase: "review",
        resolve: resolveApproval,
      };
      this.pendingApprovals.set(taskId, pending);
      const requestDialog = (
        extra: Pick<Extract<TaskEvent, { type: "approval_requested" }>["payload"], "tier" | "review"> = {},
      ) => {
        if (
          controller.signal.aborted ||
          this.storageInterrupted ||
          this.pendingApprovals.get(taskId) !== pending ||
          this.requireTask(taskId).status !== "running"
        ) return;
        pending.phase = "dialog";
        this.appendEvent(taskId, {
          type: "approval_requested",
          payload: { approvalId, summary, reasons, ...extra },
        });
      };
      const run = async () => {
        if (
          this.approvalReview === undefined ||
          this.approvalReview.reviewers.length === 0
        ) {
          requestDialog();
          return;
        }
        const result = await runReviewerChain(
          { decision, operation, tier: classifyApprovalTier(decision) },
          this.approvalReview,
          controller.signal,
        );
        if (
          result === null ||
          controller.signal.aborted ||
          this.storageInterrupted ||
          this.pendingApprovals.get(taskId) !== pending ||
          this.requireTask(taskId).status !== "running"
        ) {
          this.abortApproval(taskId);
          return;
        }
        this.appendEvent(taskId, {
          type: "approval_reviewed",
          payload: { approvalId, ...result },
        });
        if (result.review.outcome !== "ask_human") {
          this.abortApproval(taskId);
          return;
        }
        requestDialog(result);
      };
      void run().catch(() => this.abortApproval(taskId));
    });
  }

  private refreshProgress(taskId: string): void {
    const snapshot = this.requireTask(taskId);
    const accumulatedPausedSeconds = this.repository
      .events(taskId)
      .reduce((total, event) => {
        if (
          event.type === "approval_resolved" ||
          event.type === "backoff_finished" ||
          event.type === "task_resumed"
        ) {
          return total + event.payload.pausedSeconds;
        }
        return total;
      }, 0);
    const progress = computeProgress({
      now: this.now(),
      startedAt: snapshot.activeSince ?? snapshot.createdAt,
      pausedAt: snapshot.pausedSince,
      accumulatedPausedSeconds,
      steps: this.repository.steps(taskId),
    });
    const next = {
      ...snapshot,
      progress,
      updatedAt: this.now(),
    };
    this.repository.saveSnapshot(next);
    this.emit(next);
  }

  private captureRecoveryResults(taskId: string): void {
    const recovered = new Map<string, ToolResult>();
    const legacyFingerprints = new Map<string, string>();
    for (const item of this.repository.messages(taskId)) {
      if (
        item.message.role !== "assistant" ||
        item.message.toolCalls === undefined
      ) {
        continue;
      }
      for (const modelCall of item.message.toolCalls) {
        try {
          const call = parseToolCall(modelCall);
          legacyFingerprints.set(call.id, toolFingerprint(call));
        } catch {
          // Invalid historic calls cannot be made safely idempotent.
        }
      }
    }
    for (const event of this.repository.events(taskId)) {
      if (event.type !== "tool_completed") {
        continue;
      }
      const fingerprint =
        event.payload.fingerprint ??
        legacyFingerprints.get(event.payload.callId);
      if (fingerprint === undefined) {
        continue;
      }
      recovered.set(fingerprint, {
        callId: event.payload.callId,
        name: event.payload.name,
        ok: event.payload.ok,
        content: event.payload.content,
        denied: event.payload.denied,
        data: event.payload.data,
      });
    }
    this.recoveryResults.set(taskId, recovered);
  }

  private bumpCurrentStep(taskId: string, amount: number): void {
    const snapshot = this.requireTask(taskId);
    if (snapshot.currentStepId === null || snapshot.status !== "running") {
      return;
    }
    const step = this.repository
      .steps(taskId)
      .find((candidate) => candidate.id === snapshot.currentStepId);
    if (step === undefined || step.status !== "running") {
      return;
    }
    this.repository.updateStep({
      ...step,
      observedFraction: Math.min(
        0.85,
        Math.max(step.observedFraction, step.observedFraction + amount),
      ),
    });
    this.refreshProgress(taskId);
  }

  private markCurrentStepFailed(taskId: string): void {
    const snapshot = this.requireTask(taskId);
    if (snapshot.currentStepId === null) {
      return;
    }
    const step = this.repository
      .steps(taskId)
      .find((candidate) => candidate.id === snapshot.currentStepId);
    if (step === undefined) {
      return;
    }
    this.repository.updateStep({
      ...step,
      status: "failed",
    });
  }

  private appendEvent(
    taskId: string,
    event: Omit<TaskEvent, "id" | "taskId" | "at">,
  ): TaskSnapshot {
    this.throwIfStorageInterrupted();
    const completeEvent = {
      ...event,
      id: this.createId(),
      taskId,
      at: this.now(),
    } as TaskEvent;
    const next = this.repository.appendEvent(completeEvent);
    this.emit(next, completeEvent);
    return next;
  }

  private requireTask(taskId: string): TaskSnapshot {
    const snapshot = this.repository.get(taskId);
    if (snapshot === null) {
      throw new Error(`任务 ${taskId} 不存在。`);
    }
    return snapshot;
  }

  private throwIfStorageInterrupted(): void {
    if (this.storageInterrupted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  private emit(snapshot: TaskSnapshot, event?: TaskEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot, event);
      } catch {
        // Renderer delivery failures must not change task execution state.
      }
    }
  }
}
