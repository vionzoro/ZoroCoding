import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type RuntimeToolRegistry,
} from "../../src/main/agent/agentRuntime";
import {
  parseTaskPlan,
  PLANNING_SYSTEM_PROMPT,
} from "../../src/main/agent/planParser";
import type { ModelEvent, ModelRequest } from "../../src/main/models/types";
import { ModelProviderError } from "../../src/main/models/openAiCompatibleProvider";
import { openDatabase } from "../../src/main/persistence/database";
import { TaskRepository } from "../../src/main/persistence/taskRepository";
import { FileTools } from "../../src/main/tools/fileTools";
import { PermissionEngine } from "../../src/main/tools/permissionEngine";
import { ShellTool } from "../../src/main/tools/shellTool";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import type {
  PermissionDecision,
  ProjectSummary,
  ToolCall,
  ToolOperation,
  ToolResult,
} from "../../src/shared/domain";
import type { TaskExecutionMode } from "../../src/shared/taskRouting";

type ModelTurn = ModelEvent[] | Error;

function plan(
  steps = [
    {
      title: "检查文件",
      completionCriteria: "文件已成功读取",
      estimateSeconds: 30,
    },
  ],
): ModelEvent[] {
  return [
    {
      type: "text_delta",
      text: JSON.stringify({ title: "检查项目", steps }),
    },
    { type: "finish", reason: "stop" },
  ];
}

function toolCall(
  name: ToolCall["name"],
  arguments_: Record<string, unknown>,
  id = "call-1",
): ModelEvent[] {
  return [
    {
      type: "tool_call",
      call: { id, name, arguments: JSON.stringify(arguments_) },
    },
    { type: "finish", reason: "tool_calls" },
  ];
}

function answer(text = "任务已经完成。"): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "finish", reason: "stop" },
  ];
}

async function* events(turn: ModelTurn): AsyncIterable<ModelEvent> {
  if (turn instanceof Error) {
    throw turn;
  }
  for (const event of turn) {
    yield event;
  }
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for runtime state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("plan parser", () => {
  it("accepts strict bounded JSON plans", () => {
    expect(
      parseTaskPlan(
        JSON.stringify({
          title: "优化页面",
          steps: [
            {
              title: "检查组件",
              completionCriteria: "找到页面入口",
              estimateSeconds: 60,
            },
          ],
        }),
      ).steps,
    ).toHaveLength(1);
  });

  it("rejects markdown fences, extra properties, and invalid estimates", () => {
    expect(() =>
      parseTaskPlan(
        '```json\n{"title":"任务","steps":[]}\n```',
      ),
    ).toThrow();
    expect(() =>
      parseTaskPlan(
        JSON.stringify({
          title: "任务",
          extra: true,
          steps: [
            {
              title: "步骤",
              completionCriteria: "完成",
              estimateSeconds: 1,
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe("AgentRuntime", () => {
  let projectPath: string;
  let database: ReturnType<typeof openDatabase>;
  let repository: TaskRepository;
  let project: ProjectSummary;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "zorocoding-agent-"));
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(join(projectPath, "src", "App.tsx"), "export default 1;\n");
    database = openDatabase(":memory:");
    repository = new TaskRepository(database);
    project = {
      id: "project-1",
      name: "demo",
      canonicalPath: projectPath,
      lastOpenedAt: 100,
    };
  });

  afterEach(async () => {
    database.close();
    await rm(projectPath, { recursive: true, force: true });
  });

  function harness(
    modelTurns: ModelTurn[],
    configureTools?: (
      approval: (
        decision: PermissionDecision,
        operation: ToolOperation,
      ) => Promise<boolean>,
      executionMode: TaskExecutionMode,
    ) => RuntimeToolRegistry,
    overrides: Partial<AgentRuntimeOptions> = {},
  ) {
    const pendingTurns = [...modelTurns];
    const requests: ModelRequest[] = [];
    const stream = vi.fn(
      (_providerId: string, request: ModelRequest) => {
        requests.push(request);
        const turn = pendingTurns.shift();
        if (turn === undefined) {
          throw new Error("No model turn was configured");
        }
        return events(turn);
      },
    );
    const executed: ToolCall[] = [];
    const runtime = new AgentRuntime({
      repository,
      modelGateway: { stream },
      createTools: (_root, executionMode, approval) =>
        configureTools?.(approval, executionMode) ?? {
          definitions: [],
          execute: async (call) => {
            executed.push(call);
            return {
              callId: call.id,
              name: call.name,
              ok: true,
              content: "tool ok",
            };
          },
          cancelAll: async () => {},
        },
      now: () => Date.now(),
      sleep: async () => {},
      ...overrides,
    });
    return { runtime, stream, requests, executed };
  }

  const input = (executionMode: TaskExecutionMode = "read_only") => ({
    project,
    prompt: "检查并修复 App 组件",
    provider: {
      providerId: "kimi",
      name: "KIMI K3",
      kind: "kimi" as const,
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
    },
    routeDecision: {
      intent: "simple_text" as const,
      lane: "light" as const,
      executionMode,
      confidence: "high" as const,
      reasonCode: "text-transform" as const,
    },
    selectionMode: "auto" as const,
  });

  it("plans, executes a tool, updates progress, and completes", async () => {
    const { runtime, executed } = harness([
      plan(),
      toolCall("read_file", { path: "src/App.tsx" }),
      answer("文件有效。"),
    ]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(repository.get(task.id)?.progress.percent).toBe(100);
    expect(repository.steps(task.id)[0].status).toBe("completed");
    expect(executed).toHaveLength(1);
    expect(repository.events(task.id).map((event) => event.type)).toContain(
      "tool_completed",
    );
  });

  it("contains task subscriber failures without failing execution", async () => {
    const { runtime } = harness([
      plan(),
      toolCall("read_file", { path: "src/App.tsx" }),
      answer("文件有效。"),
    ]);
    runtime.subscribe(() => {
      throw new Error("renderer listener failed");
    });

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
  });

  it("executes the advertised list_files tool and persists its events before completing", async () => {
    const { runtime } = harness(
      [
        plan(),
        toolCall("list_files", { path: "." }),
        answer("项目文件已经列出。"),
      ],
      (approval, executionMode) =>
        new ToolRegistry(
          projectPath,
          executionMode,
          new FileTools(projectPath),
          new ShellTool(projectPath),
          new PermissionEngine(),
          approval,
        ),
    );

    const task = await runtime.createTask(input("read_only"));
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(
      repository.events(task.id).filter(
        (event) =>
          (event.type === "tool_started" ||
            event.type === "tool_completed") &&
          event.payload.name === "list_files",
      ),
    ).toHaveLength(2);
  });

  it("uses persisted read-only capabilities, denies malformed forged mutations visibly, and causes no side effects", async () => {
    const shell = {
      run: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        durationMs: 1,
        output: "unexpected",
        canceled: false,
      })),
      cancelAll: vi.fn(async () => {}),
    };
    const approval = vi.fn(async () => true);
    const calls: ModelTurn[] = [
      plan(),
      [
        {
          type: "tool_call",
          call: {
            id: "forged-write",
            name: "write_file",
            arguments: "{",
          },
        },
        {
          type: "tool_call",
          call: {
            id: "forged-shell",
            name: "run_shell",
            arguments: "{",
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      answer("只读检查完成。"),
    ];
    const { runtime, requests } = harness(calls, undefined, {
      createTools: (root, executionMode, requestApproval) =>
        new ToolRegistry(
          root,
          executionMode,
          new FileTools(root),
          shell as unknown as ShellTool,
          new PermissionEngine(),
          async (decision, operation) => {
            approval();
            return requestApproval(decision, operation);
          },
        ),
    });

    const task = await runtime.createTask(input("read_only"));
    await runtime.waitForIdle();

    expect(
      requests[1].tools.map((item) => item.function.name),
    ).toEqual(["list_files", "read_file", "search_files"]);
    expect(requests[1].messages[0].content).toContain(
      "可以列出、搜索和读取",
    );
    expect(requests[1].messages[0].content).toContain(
      "不得修改文件、运行命令或声称",
    );
    const denied = repository
      .events(task.id)
      .filter((event) => event.type === "tool_completed");
    expect(denied).toHaveLength(2);
    expect(
      denied.every(
        (event) =>
          event.type === "tool_completed" &&
          event.payload.ok === false &&
          event.payload.denied,
      ),
    ).toBe(true);
    expect(
      repository
        .events(task.id)
        .some((event) => event.type === "approval_requested"),
    ).toBe(false);
    expect(approval).not.toHaveBeenCalled();
    expect(shell.run).not.toHaveBeenCalled();
    expect(await readFile(join(projectPath, "src", "App.tsx"), "utf8")).toBe(
      "export default 1;\n",
    );
    expect(requests[0].messages[0].content).toContain(
      "列出、搜索和读取",
    );
    expect(requests[0].messages[0].content).toContain(
      "不得修改文件、运行命令或声称",
    );
  });

  it.each([
    {
      executionMode: "read_only" as const,
      name: "read_file" as const,
    },
    {
      executionMode: "agentic" as const,
      name: "run_shell" as const,
    },
  ])(
    "still rejects malformed JSON for $executionMode $name calls",
    async ({ executionMode, name }) => {
      const malformed: ModelEvent[] = [
        {
          type: "tool_call",
          call: { id: "malformed-allowed", name, arguments: "{" },
        },
        { type: "finish", reason: "tool_calls" },
      ];
      const { runtime } = harness([plan(), malformed]);

      const task = await runtime.createTask(input(executionMode));
      await runtime.waitForIdle();

      expect(repository.get(task.id)?.status).toBe("failed");
      expect(
        repository
          .events(task.id)
          .some((event) => event.type === "tool_started"),
      ).toBe(false);
    },
  );

  it("repairs one invalid planning response before executing", async () => {
    const { runtime, stream } = harness([
      [
        { type: "text_delta", text: "not json" },
        { type: "finish", reason: "stop" },
      ],
      plan(),
      answer(),
    ]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it("fails safely when the repaired plan is still invalid", async () => {
    const invalid = [
      { type: "text_delta" as const, text: "not json" },
      { type: "finish" as const, reason: "stop" },
    ];
    const { runtime } = harness([invalid, invalid]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("failed");
    expect(repository.events(task.id).at(-1)?.type).toBe("task_failed");
  });

  it("pauses ETA while waiting for destructive-command approval", async () => {
    const { runtime, requests } = harness(
      [
        plan(),
        toolCall("run_shell", { command: "rm -rf build" }),
        answer("已按用户决定继续。"),
      ],
      (approval) => ({
        definitions: [],
        execute: async (call) => {
          const allowed = await approval(
            {
              level: "ask",
              summary: "确认运行高风险命令",
              reasons: ["命令会删除文件或目录"],
              reasonCodes: ["delete"],
            },
            { kind: "shell", command: "rm -rf build" },
          );
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            denied: !allowed,
            content: allowed ? "allowed" : "denied",
          };
        },
        cancelAll: async () => {},
      }),
    );

    const task = await runtime.createTask(input("agentic"));
    await waitUntil(
      () => repository.get(task.id)?.status === "awaiting_approval",
    );

    expect(repository.get(task.id)?.progress.estimationState).toBe("paused");
    await runtime.resolveApproval(task.id, "deny");
    await runtime.waitForIdle();

    expect(repository.events(task.id).map((event) => event.type)).toContain(
      "approval_resolved",
    );
    expect(repository.get(task.id)?.status).toBe("completed");
    expect(requests[0].messages[0].content).toBe(
      PLANNING_SYSTEM_PROMPT,
    );
  });

  it("pauses ETA during retryable model backoff, honors Retry-After, and then recovers", async () => {
    const observedStatuses: string[] = [];
    const observedDelays: number[] = [];
    const retryable = new ModelProviderError({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 250,
    });
    let runtime: AgentRuntime;
    const built = harness([retryable, plan(), answer()], undefined, {
      sleep: async (milliseconds) => {
        observedDelays.push(milliseconds);
        observedStatuses.push(
          repository.list()[0]?.progress.estimationState ?? "missing",
        );
      },
    });
    runtime = built.runtime;

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(observedStatuses).toEqual(["paused"]);
    expect(observedDelays).toEqual([250]);
    expect(repository.get(task.id)?.status).toBe("completed");
    expect(repository.events(task.id).map((event) => event.type)).toContain(
      "backoff_started",
    );
  });

  it("cancels an active model request and leaves the task canceled", async () => {
    let release: (() => void) | undefined;
    const blockedTurn: ModelTurn = [];
    const runtimeOptions: Partial<AgentRuntimeOptions> = {
      modelGateway: {
        stream: (_providerId, request) =>
          (async function* () {
            await new Promise<void>((resolve) => {
              release = resolve;
              request.signal?.addEventListener("abort", resolve, {
                once: true,
              });
            });
            if (request.signal?.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            yield { type: "finish", reason: "stop" };
          })(),
      },
    };
    const { runtime } = harness([blockedTurn], undefined, runtimeOptions);

    const task = await runtime.createTask(input());
    await waitUntil(() => repository.get(task.id)?.status === "planning");
    await runtime.cancel(task.id);
    release?.();
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("canceled");
  });

  it("pauses and resumes a planning request without losing the task", async () => {
    let modelCall = 0;
    let markBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          if (modelCall === 1) {
            markBlocked?.();
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener("abort", resolve, {
                once: true,
              });
            });
            throw new DOMException("Aborted", "AbortError");
          }
          const turn = modelCall === 2 ? plan() : answer();
          for (const event of turn) {
            yield event;
          }
        })(),
    };
    const { runtime } = harness([], undefined, { modelGateway });

    const task = await runtime.createTask(input());
    await blocked;
    await runtime.pause(task.id);
    await runtime.waitForIdle();
    expect(repository.get(task.id)?.status).toBe("paused");

    await runtime.resume(task.id);
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(modelCall).toBe(3);
  });

  it("pauses every active task when the application window closes", async () => {
    let release: (() => void) | undefined;
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          await new Promise<void>((resolve) => {
            release = resolve;
            request.signal?.addEventListener("abort", resolve, {
              once: true,
            });
          });
          if (request.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield { type: "finish", reason: "stop" };
        })(),
    };
    const { runtime } = harness([], undefined, { modelGateway });

    const task = await runtime.createTask(input());
    await waitUntil(() => repository.get(task.id)?.status === "planning");
    await runtime.pauseActiveTasks();
    release?.();
    await runtime.waitForIdle();

    expect(repository.get(task.id)).toMatchObject({
      status: "paused",
      pauseReason: "user",
    });
  });

  it("does not execute the same completed operation again when a resumed model changes its call id", async () => {
    let modelCall = 0;
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          if (modelCall === 3) {
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener("abort", resolve, {
                once: true,
              });
            });
            throw new DOMException("Aborted", "AbortError");
          }
          const turn =
            modelCall === 1
              ? plan()
              : modelCall === 2
                ? toolCall("read_file", { path: "src/App.tsx" }, "original-call")
                : modelCall === 4
                  ? toolCall("read_file", { path: "src/App.tsx" }, "changed-call")
                : answer();
          for (const event of turn) {
            yield event;
          }
        })(),
    };
    const execute = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      name: call.name,
      ok: true,
      content: "read once",
    }));
    const { runtime } = harness(
      [],
      () => ({
        definitions: [],
        execute,
        cancelAll: async () => {},
      }),
      { modelGateway },
    );

    const task = await runtime.createTask(input());
    await waitUntil(() =>
      repository
        .events(task.id)
        .some((event) => event.type === "tool_completed"),
    );
    await runtime.pause(task.id);
    await runtime.waitForIdle();
    await runtime.resume(task.id);
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a legacy tool fingerprint from persisted assistant calls", async () => {
    let modelCall = 0;
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          if (modelCall === 3) {
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener("abort", resolve, {
                once: true,
              });
            });
            throw new DOMException("Aborted", "AbortError");
          }
          const turn =
            modelCall === 1
              ? plan()
              : modelCall === 2
                ? toolCall("read_file", { path: "src/App.tsx" }, "legacy-call")
                : modelCall === 4
                  ? toolCall("read_file", { path: "src/App.tsx" }, "new-call")
                  : answer();
          for (const event of turn) {
            yield event;
          }
        })(),
    };
    const execute = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      name: call.name,
      ok: true,
      content: "read once",
    }));
    const { runtime } = harness(
      [],
      () => ({
        definitions: [],
        execute,
        cancelAll: async () => {},
      }),
      { modelGateway },
    );

    const task = await runtime.createTask(input());
    await waitUntil(() =>
      repository
        .events(task.id)
        .some((event) => event.type === "tool_completed"),
    );
    const completedRow = database
      .prepare(
        "SELECT id, payload_json FROM task_events WHERE task_id = ? AND event_type = 'tool_completed'",
      )
      .get(task.id) as { id: string; payload_json: string };
    const legacyPayload = JSON.parse(completedRow.payload_json) as Record<
      string,
      unknown
    >;
    delete legacyPayload.fingerprint;
    database
      .prepare("UPDATE task_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(legacyPayload), completedRow.id);

    await runtime.pause(task.id);
    await runtime.waitForIdle();
    await runtime.resume(task.id);
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps a backoff task paused when the application window closes", async () => {
    const retryable = new ModelProviderError({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 30_000,
    });
    let enteredBackoff: (() => void) | undefined;
    const backoffStarted = new Promise<void>((resolve) => {
      enteredBackoff = resolve;
    });
    const { runtime, stream } = harness([retryable, plan(), answer()], undefined, {
      sleep: async (_milliseconds, signal?: AbortSignal) => {
        enteredBackoff?.();
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const task = await runtime.createTask(input());
    await backoffStarted;
    expect(repository.get(task.id)).toMatchObject({
      status: "paused",
      pauseReason: "backoff",
    });

    await runtime.pauseActiveTasks();
    await runtime.waitForIdle();

    expect(repository.get(task.id)).toMatchObject({
      status: "paused",
      pauseReason: "user",
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("marks the active step failed when execution fails", async () => {
    const fatal = new ModelProviderError({
      code: "auth",
      message: "bad key",
      retryable: false,
      retryAfterMs: null,
    });
    const { runtime } = harness([plan(), fatal]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("failed");
    expect(repository.steps(task.id)[0].status).toBe("failed");
  });

  it("publishes model text deltas before storing the final message", async () => {
    const { runtime } = harness([
      plan(),
      answer("流式结果"),
    ]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    expect(repository.events(task.id).map((event) => event.type)).toContain(
      "model_output",
    );
  });

  it("batches rapid model deltas into bounded persisted updates", async () => {
    const streamed = [
      ...Array.from(
        { length: 100 },
        () => ({ type: "text_delta" as const, text: "x" }),
      ),
      { type: "finish" as const, reason: "stop" },
    ];
    const { runtime } = harness([plan(), streamed]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();

    const outputEvents = repository
      .events(task.id)
      .filter(
        (event) =>
          event.type === "model_output" &&
          event.payload.text.includes("x"),
      );
    expect(outputEvents).toHaveLength(1);
    expect(
      outputEvents
        .map((event) =>
          event.type === "model_output" ? event.payload.text : "",
        )
        .join(""),
    ).toBe("x".repeat(100));
  });

  it("batches rapid terminal chunks before persisting live output", async () => {
    const { runtime } = harness(
      [
        plan(),
        toolCall("run_shell", { command: "pwd" }),
        answer(),
      ],
      () => ({
        definitions: [],
        execute: async (call, onOutput) => {
          for (let index = 0; index < 100; index += 1) {
            onOutput?.({ stream: "stdout", text: "x" });
          }
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: "x".repeat(100),
          };
        },
        cancelAll: async () => {},
      }),
    );

    const task = await runtime.createTask(input("agentic"));
    await runtime.waitForIdle();

    const outputEvents = repository
      .events(task.id)
      .filter((event) => event.type === "tool_output");
    expect(outputEvents).toHaveLength(1);
    expect(
      outputEvents
        .map((event) =>
          event.type === "tool_output" ? event.payload.text : "",
        )
        .join(""),
    ).toBe("x".repeat(100));
  });

  it("retries a failed step without discarding its event history", async () => {
    const fatal = new ModelProviderError({
      code: "auth",
      message: "temporary bad key",
      retryable: false,
      retryAfterMs: null,
    });
    const { runtime } = harness([plan(), fatal, answer("重试完成")]);

    const task = await runtime.createTask(input());
    await runtime.waitForIdle();
    const eventsBeforeRetry = repository.events(task.id).length;

    await runtime.retry(task.id);
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(repository.steps(task.id)[0].status).toBe("completed");
    expect(repository.events(task.id).length).toBeGreaterThan(eventsBeforeRetry);
    expect(repository.events(task.id).map((event) => event.type)).toContain(
      "task_retried",
    );
  });

  it("preserves authoritative route metadata through pause, resume, messages, retry, and reload", async () => {
    let modelCall = 0;
    const observedExecutionModes: TaskExecutionMode[] = [];
    let planningStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      planningStarted = resolve;
    });
    const fatal = new ModelProviderError({
      code: "auth",
      message: "temporary bad key",
      retryable: false,
      retryAfterMs: null,
    });
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          if (modelCall === 1) {
            planningStarted?.();
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener("abort", resolve, {
                once: true,
              });
            });
            throw new DOMException("Aborted", "AbortError");
          }
          const turn = modelCall === 2
            ? plan()
            : modelCall === 3
              ? fatal
              : answer("重试完成");
          if (turn instanceof Error) throw turn;
          for (const event of turn) yield event;
        })(),
    };
    const { runtime } = harness(
      [],
      (_approval, executionMode) => {
        observedExecutionModes.push(executionMode);
        return {
          definitions: [],
          execute: async () => {
            throw new Error("No tool call was expected");
          },
          cancelAll: async () => {},
        };
      },
      { modelGateway },
    );
    const expectedRouting = {
      providerSnapshot: input().provider,
      routeDecision: input().routeDecision,
      selectionMode: "auto",
      executionMode: "read_only",
    };

    const task = await runtime.createTask(input());
    expect(repository.get(task.id)).toMatchObject(expectedRouting);

    await started;
    await runtime.pause(task.id);
    await runtime.waitForIdle();
    expect(repository.get(task.id)).toMatchObject(expectedRouting);

    await runtime.addMessage(task.id, "补充无障碍标签");
    expect(repository.get(task.id)).toMatchObject(expectedRouting);

    await runtime.resume(task.id);
    await runtime.waitForIdle();
    expect(repository.get(task.id)).toMatchObject({
      ...expectedRouting,
      status: "failed",
    });

    await runtime.retry(task.id);
    await runtime.waitForIdle();
    expect(repository.get(task.id)).toMatchObject({
      ...expectedRouting,
      status: "completed",
    });

    expect(new TaskRepository(database).get(task.id)).toMatchObject(
      expectedRouting,
    );
    expect(observedExecutionModes).toEqual(["read_only", "read_only"]);
  });

  it("includes a supplemental user requirement when a paused step resumes", async () => {
    let modelCall = 0;
    let stepBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      stepBlocked = resolve;
    });
    const requests: ModelRequest[] = [];
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          requests.push(request);
          if (modelCall === 1) {
            for (const event of plan()) yield event;
            return;
          }
          if (modelCall === 2) {
            stepBlocked?.();
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener("abort", resolve, {
                once: true,
              });
            });
            throw new DOMException("Aborted", "AbortError");
          }
          for (const event of answer("已应用补充要求")) yield event;
        })(),
    };
    const { runtime } = harness([], undefined, { modelGateway });

    const task = await runtime.createTask(input());
    await blocked;
    await runtime.pause(task.id);
    await runtime.waitForIdle();
    await runtime.addMessage(task.id, "同时补充无障碍标签");
    await runtime.resume(task.id);
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(
      requests[2].messages.some(
        (message) =>
          message.role === "user" &&
          message.content === "同时补充无障碍标签",
      ),
    ).toBe(true);
  });

  it("does not finish a step until a requirement submitted during streaming is consumed", async () => {
    let modelCall = 0;
    let markStreaming: (() => void) | undefined;
    let releaseStreaming: (() => void) | undefined;
    const streaming = new Promise<void>((resolve) => {
      markStreaming = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseStreaming = resolve;
    });
    const requests: ModelRequest[] = [];
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          requests.push(request);
          if (modelCall === 1) {
            for (const event of plan()) yield event;
            return;
          }
          if (modelCall === 2) {
            markStreaming?.();
            await release;
            for (const event of answer("原要求已完成")) yield event;
            return;
          }
          for (const event of answer("补充要求也已完成")) yield event;
        })(),
    };
    const { runtime } = harness([], undefined, { modelGateway });

    const task = await runtime.createTask(input());
    await streaming;
    await runtime.addMessage(task.id, "再补充错误状态文案");
    releaseStreaming?.();
    await runtime.waitForIdle();

    expect(repository.get(task.id)?.status).toBe("completed");
    expect(modelCall).toBe(3);
    expect(
      requests[2].messages.some(
        (message) =>
          message.role === "user" &&
          message.content === "再补充错误状态文案",
      ),
    ).toBe(true);
  });

  it("aborts active model work and tools on storage loss without writing another event", async () => {
    let modelCall = 0;
    let modelStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const modelGateway: AgentRuntimeOptions["modelGateway"] = {
      stream: (_providerId, request) =>
        (async function* () {
          modelCall += 1;
          if (modelCall === 1) {
            for (const event of plan()) yield event;
            return;
          }
          modelStarted?.();
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", resolve, { once: true });
          });
          throw new DOMException("Aborted", "AbortError");
        })(),
    };
    const cancelAll = vi.fn(async () => {});
    const { runtime } = harness(
      [],
      () => ({
        definitions: [],
        execute: async () => {
          throw new Error("A tool should not run in this test");
        },
        cancelAll,
      }),
      { modelGateway },
    );

    const task = await runtime.createTask(input());
    await started;
    const eventsBeforeLoss = repository.events(task.id);

    await runtime.interruptForStorageLoss();
    await runtime.waitForIdle();

    expect(cancelAll).toHaveBeenCalledOnce();
    expect(repository.events(task.id)).toEqual(eventsBeforeLoss);
  });

  it("bounds a hanging tool cancellation after rejecting active work", async () => {
    let modelStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let calls = 0;
    const { runtime } = harness([], () => ({
      definitions: [], execute: async () => { throw new Error("unused"); },
      cancelAll: () => new Promise<void>(() => {}),
    }), {
      storageCancellationTimeoutMs: 1,
      modelGateway: { stream: (_id, request) => (async function* () {
        calls += 1;
        if (calls === 1) { for (const event of plan()) yield event; return; }
        modelStarted?.();
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", resolve, { once: true }));
        throw new DOMException("Aborted", "AbortError");
      })() },
    });
    await runtime.createTask(input());
    await started;
    await expect(runtime.interruptForStorageLoss()).resolves.toBeUndefined();
  });
});
