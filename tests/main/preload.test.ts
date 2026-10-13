import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloneQuickChatEventEnvelope } from "../../src/preload/quickChatEventValidation";
import { cloneTaskEventEnvelope } from "../../src/preload/taskEventValidation";
import {
  quickChatEventEnvelopeSchema,
  taskEventEnvelopeSchema,
} from "../../src/shared/ipc";
import { TOOL_NAME_VALUES } from "../../src/shared/toolNames";
import type {
  QuickChatEventEnvelope,
  QuickChatRetryRequest,
  QuickChatSendRequest,
  RoutePreviewRequest,
  TaskEventEnvelope,
  UpdateRoutingConfigRequest,
  ZoroApi,
} from "../../src/shared/ipc";

type IpcListener = (event: unknown, payload: unknown) => void;

const electronHarness = vi.hoisted(() => {
  const listeners = new Map<string, Set<IpcListener>>();
  const invocations: Array<{ channel: string; args: unknown[] }> = [];
  const sends: Array<{ channel: string; args: unknown[] }> = [];
  let exposedName: string | undefined;
  let exposedApi: ZoroApi | undefined;

  return {
    listeners,
    invocations,
    sends,
    expose(name: string, api: ZoroApi) {
      exposedName = name;
      exposedApi = api;
    },
    exposed() {
      return { name: exposedName, api: exposedApi };
    },
    reset() {
      listeners.clear();
      invocations.length = 0;
      sends.length = 0;
      exposedName = undefined;
      exposedApi = undefined;
    },
    emit(channel: string, payload: unknown) {
      for (const listener of [...(listeners.get(channel) ?? [])]) {
        listener({}, payload);
      }
    },
  };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld(name: string, api: ZoroApi) {
      electronHarness.expose(name, api);
    },
  },
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]) {
      electronHarness.invocations.push({ channel, args });
      return Promise.resolve({ channel, args });
    },
    on(channel: string, listener: IpcListener) {
      const listeners =
        electronHarness.listeners.get(channel) ?? new Set<IpcListener>();
      listeners.add(listener);
      electronHarness.listeners.set(channel, listeners);
    },
    removeListener(channel: string, listener: IpcListener) {
      electronHarness.listeners.get(channel)?.delete(listener);
    },
    send(channel: string, ...args: unknown[]) {
      electronHarness.sends.push({ channel, args });
    },
  },
}));

async function loadPreload(): Promise<ZoroApi> {
  vi.resetModules();
  await import("../../src/preload/index");
  const exposed = electronHarness.exposed();
  expect(exposed.name).toBe("zoro");
  expect(exposed.api).toBeDefined();
  return exposed.api!;
}

describe("strict preload API", () => {
  beforeEach(() => {
    electronHarness.reset();
  });

  it("exposes frozen integration methods and forwards only the explicit fields", async () => {
    const api = await loadPreload();
    expect(Object.isFrozen(api.integrations)).toBe(true);
    expect(Object.keys(api.integrations).sort()).toEqual(["get", "update"]);
    await api.integrations.get("optional-service");
    const input = {
      id: "optional-service", enabled: false, endpoint: "", token: "write-only-token",
      options: { readEnabled: true },
      secretRef: "forbidden-reference",
    };
    await api.integrations.update(input);
    expect(electronHarness.invocations).toEqual([
      { channel: "zoro:integrations:get", args: [{ id: "optional-service" }] },
      { channel: "zoro:integrations:update", args: [{
        id: "optional-service", enabled: false, endpoint: "", token: "write-only-token", options: { readEnabled: true },
      }] },
    ]);
  });

  it("exposes only frozen named routing and Quick Chat methods", async () => {
    const api = await loadPreload();

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.routing)).toBe(true);
    expect(Object.isFrozen(api.quickChat)).toBe(true);
    expect(Object.keys(api.routing).sort()).toEqual([
      "get",
      "preview",
      "update",
    ]);
    expect(Object.keys(api.quickChat).sort()).toEqual([
      "cancel",
      "createSession",
      "deleteSession",
      "listMessages",
      "listSessions",
      "renameSession",
      "retry",
      "send",
      "subscribe",
    ]);
    expect("invoke" in api).toBe(false);
    expect("invoke" in api.routing).toBe(false);
    expect("invoke" in api.quickChat).toBe(false);
  });

  it("invokes only the explicit routing and Quick Chat channel allowlist", async () => {
    const api = await loadPreload();
    const update = {
      lightProviderId: "light-1",
      premiumProviderId: "premium-1",
      projectPath: "/forbidden",
    } as UpdateRoutingConfigRequest;
    const preview = {
      prompt: "hello",
      selection: {
        mode: "manual",
        providerId: "provider-1",
        tools: ["read_file"],
      },
      projectId: "forbidden",
      command: "pwd",
    } as RoutePreviewRequest;
    const send = {
      sessionId: "session-1",
      prompt: "hello",
      selection: { mode: "auto", providerId: "forbidden" },
      projectPath: "/forbidden",
      tools: [],
    } as QuickChatSendRequest;
    const retry = {
      sessionId: "session-1",
      messageId: "message-1",
      selection: {
        mode: "manual",
        providerId: "provider-1",
        command: "pwd",
      },
      projectId: "forbidden",
    } as QuickChatRetryRequest;

    await api.routing.get();
    await api.routing.update(update);
    await api.routing.preview(preview);
    await api.quickChat.listSessions();
    await api.quickChat.createSession();
    await api.quickChat.renameSession("session-1", "New title");
    await api.quickChat.deleteSession("session-1");
    await api.quickChat.listMessages("session-1");
    await api.quickChat.send(send);
    await api.quickChat.cancel("session-1");
    await api.quickChat.retry(retry);

    expect(electronHarness.invocations).toEqual([
      { channel: "zoro:routing:get", args: [] },
      {
        channel: "zoro:routing:update",
        args: [
          {
            lightProviderId: "light-1",
            premiumProviderId: "premium-1",
          },
        ],
      },
      {
        channel: "zoro:routing:preview",
        args: [
          {
            prompt: "hello",
            selection: {
              mode: "manual",
              providerId: "provider-1",
            },
          },
        ],
      },
      { channel: "zoro:quick-chat:list-sessions", args: [] },
      { channel: "zoro:quick-chat:create-session", args: [] },
      {
        channel: "zoro:quick-chat:rename-session",
        args: [{ sessionId: "session-1", title: "New title" }],
      },
      {
        channel: "zoro:quick-chat:delete-session",
        args: [{ sessionId: "session-1" }],
      },
      {
        channel: "zoro:quick-chat:list-messages",
        args: [{ sessionId: "session-1" }],
      },
      {
        channel: "zoro:quick-chat:send",
        args: [
          {
            sessionId: "session-1",
            prompt: "hello",
            selection: { mode: "auto" },
          },
        ],
      },
      {
        channel: "zoro:quick-chat:cancel",
        args: [{ sessionId: "session-1" }],
      },
      {
        channel: "zoro:quick-chat:retry",
        args: [
          {
            sessionId: "session-1",
            messageId: "message-1",
            selection: {
              mode: "manual",
              providerId: "provider-1",
            },
          },
        ],
      },
    ]);
    const invokedPayloads = electronHarness.invocations
      .filter(({ args }) => args.length === 1)
      .map(({ args }) => args[0]);
    expect(invokedPayloads).not.toContain(update);
    expect(invokedPayloads).not.toContain(preview);
    expect(invokedPayloads).not.toContain(send);
    expect(invokedPayloads).not.toContain(retry);
    expect(
      (
        electronHarness.invocations.find(
          ({ channel }) => channel === "zoro:routing:preview",
        )!.args[0] as RoutePreviewRequest
      ).selection,
    ).not.toBe(preview.selection);
    expect(
      (
        electronHarness.invocations.find(
          ({ channel }) => channel === "zoro:quick-chat:retry",
        )!.args[0] as QuickChatRetryRequest
      ).selection,
    ).not.toBe(retry.selection);
  });

  it("validates and clones Quick Chat event envelopes before delivery", async () => {
    const api = await loadPreload();
    const delivered: QuickChatEventEnvelope[] = [];
    api.quickChat.subscribe((event) => delivered.push(event));
    const subscribe = electronHarness.sends.find(
      ({ channel }) => channel === "zoro:quick-chat:subscribe",
    );
    const subscriptionId = (
      subscribe?.args[0] as { subscriptionId: string }
    ).subscriptionId;
    const envelope = {
      subscriptionId,
      event: {
        type: "session_updated",
        session: {
          id: "session-1",
          title: "Original",
          createdAt: 1,
          updatedAt: 2,
        },
      },
    } satisfies QuickChatEventEnvelope;

    electronHarness.emit("zoro:quick-chat:event", envelope);
    envelope.event.session.title = "Mutated after delivery";
    electronHarness.emit("zoro:quick-chat:event", {
      subscriptionId: "different-subscription",
      event: {
        type: "message_delta",
        sessionId: "session-1",
        messageId: "message-1",
        text: "ignored",
      },
    });
    electronHarness.emit("zoro:quick-chat:event", {
      subscriptionId,
      event: {
        type: "message_completed",
        message: {
          id: "message-1",
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
      },
    });
    electronHarness.emit("zoro:quick-chat:event", {
      subscriptionId,
      event: {
        type: "message_delta",
        sessionId: " ",
        messageId: "message-1",
        text: "invalid",
      },
    });

    expect(delivered).toEqual([
      {
        subscriptionId,
        event: {
          type: "session_updated",
          session: {
            id: "session-1",
            title: "Original",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
    ]);
    expect(delivered[0]).not.toBe(envelope);
    expect(delivered[0].event).not.toBe(envelope.event);
  });

  it("validates and clones task event envelopes before listener delivery", async () => {
    const api = await loadPreload();
    const delivered: TaskEventEnvelope[] = [];
    api.tasks.subscribe((event) => delivered.push(event));
    const subscriptionId = electronHarness.sends.find(
      ({ channel }) => channel === "zoro:tasks:subscribe",
    )!.args[0] as string;
    const envelope = completedTaskEnvelope(subscriptionId);

    electronHarness.emit("zoro:tasks:event", envelope);
    envelope.task.title = "mutated after delivery";
    electronHarness.emit("zoro:tasks:event", {
      ...completedTaskEnvelope(subscriptionId),
      task: {
        ...completedTaskEnvelope(subscriptionId).task,
        prompt: "x".repeat(100_001),
      },
    });
    electronHarness.emit("zoro:tasks:event", {
      ...completedTaskEnvelope(subscriptionId),
      event: {
        ...completedTaskEnvelope(subscriptionId).event!,
        payload: { message: "unsafe", extra: true },
      },
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0].task.title).toBe("Task");
    expect(delivered[0]).not.toBe(envelope);
    expect(delivered[0].task).not.toBe(envelope.task);
  });

  it("unsubscribes exactly the matching Quick Chat listener", async () => {
    const api = await loadPreload();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = api.quickChat.subscribe(first);
    api.quickChat.subscribe(second);
    const subscriptions = electronHarness.sends.filter(
      ({ channel }) => channel === "zoro:quick-chat:subscribe",
    );
    const firstId = (
      subscriptions[0].args[0] as { subscriptionId: string }
    ).subscriptionId;
    const secondId = (
      subscriptions[1].args[0] as { subscriptionId: string }
    ).subscriptionId;

    unsubscribeFirst();
    electronHarness.emit("zoro:quick-chat:event", {
      subscriptionId: firstId,
      event: {
        type: "message_delta",
        sessionId: "session-1",
        messageId: "message-1",
        text: "first",
      },
    });
    electronHarness.emit("zoro:quick-chat:event", {
      subscriptionId: secondId,
      event: {
        type: "message_delta",
        sessionId: "session-1",
        messageId: "message-2",
        text: "second",
      },
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(electronHarness.sends.at(-1)).toEqual({
      channel: "zoro:quick-chat:unsubscribe",
      args: [{ subscriptionId: firstId }],
    });
    expect(
      electronHarness.listeners.get("zoro:quick-chat:event")?.size,
    ).toBe(1);
  });
});

function completedEnvelope(): QuickChatEventEnvelope {
  return {
    subscriptionId: "subscription-1",
    event: {
      type: "message_completed",
      message: {
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        content: "done",
        providerSnapshot: {
          providerId: "provider-1",
          name: "Provider",
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "model-1",
          contextLength: 128_000,
        },
        routeDecision: {
          intent: "simple_qa",
          lane: "light",
          executionMode: "read_only",
          confidence: "high",
          reasonCode: "simple-question",
        },
        status: "completed",
        errorMessage: null,
        createdAt: 1,
      },
    },
  };
}

function completedTaskEnvelope(
  subscriptionId = "subscription-1",
): TaskEventEnvelope {
  return {
    subscriptionId,
    task: {
      id: "task-1",
      projectId: "project-1",
      title: "Task",
      prompt: "Explain the project",
      status: "completed",
      providerSnapshot: {
        providerId: "provider-1",
        name: "Provider",
        kind: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "model-1",
        contextLength: 128_000,
      },
      routeDecision: {
        intent: "simple_code",
        lane: "light",
        executionMode: "read_only",
        confidence: "high",
        reasonCode: "code-explanation",
      },
      selectionMode: "auto",
      executionMode: "read_only",
      progress: {
        percent: 100,
        elapsedSeconds: 2,
        remainingSeconds: 0,
        estimationState: "ready",
      },
      currentStepId: null,
      activeSince: null,
      pausedSince: null,
      pauseReason: null,
      createdAt: 1,
      updatedAt: 2,
    },
    event: {
      id: "event-1",
      taskId: "task-1",
      type: "tool_completed",
      at: 2,
      payload: {
        callId: "call-1",
        name: "list_files",
        ok: true,
        content: "src/App.tsx",
        denied: false,
        data: { paths: ["src/App.tsx"] },
      },
    },
  };
}

function withPrototype<T extends object>(
  value: T,
  prototype: object | null,
): T {
  return Object.assign(Object.create(prototype), value) as T;
}

describe("Quick Chat preload validator parity", () => {
  it.each([
    {
      name: "valid envelope",
      input: completedEnvelope(),
      accepted: true,
    },
    {
      name: "inherited enumerable extra property",
      input: withPrototype(completedEnvelope(), {
        inheritedExtra: true,
      }),
      accepted: false,
    },
    {
      name: "custom prototype without enumerable extras",
      input: withPrototype(
        completedEnvelope(),
        Object.create(null, {
          marker: { value: true, enumerable: false },
        }),
      ),
      accepted: false,
    },
    {
      name: "null-prototype envelope",
      input: withPrototype(completedEnvelope(), null),
      accepted: true,
    },
    {
      name: "extra own key",
      input: { ...completedEnvelope(), extra: true },
      accepted: false,
    },
    {
      name: "trimmed 256-character identifiers",
      input: {
        subscriptionId: `  ${"s".repeat(256)}  `,
        event: {
          type: "message_delta",
          sessionId: ` ${"a".repeat(256)} `,
          messageId: ` ${"b".repeat(256)} `,
          text: "delta",
        },
      },
      accepted: true,
    },
    {
      name: "over-limit identifier after trim",
      input: {
        subscriptionId: ` ${"s".repeat(257)} `,
        event: {
          type: "message_delta",
          sessionId: "session-1",
          messageId: "message-1",
          text: "delta",
        },
      },
      accepted: false,
    },
    {
      name: "provider with an extra secret field",
      input: (() => {
        const envelope = completedEnvelope();
        if (envelope.event.type !== "message_completed") return envelope;
        return {
          ...envelope,
          event: {
            ...envelope.event,
            message: {
              ...envelope.event.message,
              providerSnapshot: {
                ...envelope.event.message.providerSnapshot!,
                secretRef: "provider/provider-1",
              },
            },
          },
        };
      })(),
      accepted: false,
    },
    {
      name: "route with an undeclared field",
      input: (() => {
        const envelope = completedEnvelope();
        if (envelope.event.type !== "message_completed") return envelope;
        return {
          ...envelope,
          event: {
            ...envelope.event,
            message: {
              ...envelope.event.message,
              routeDecision: {
                ...envelope.event.message.routeDecision!,
                tools: [],
              },
            },
          },
        };
      })(),
      accepted: false,
    },
    {
      name: "message missing its status",
      input: (() => {
        const envelope = completedEnvelope();
        if (envelope.event.type !== "message_completed") return envelope;
        const { status: _status, ...message } = envelope.event.message;
        return {
          ...envelope,
          event: { ...envelope.event, message },
        };
      })(),
      accepted: false,
    },
    {
      name: "provider with a custom prototype",
      input: (() => {
        const envelope = completedEnvelope();
        if (envelope.event.type !== "message_completed") return envelope;
        return {
          ...envelope,
          event: {
            ...envelope.event,
            message: {
              ...envelope.event.message,
              providerSnapshot: withPrototype(
                envelope.event.message.providerSnapshot!,
                { inherited: true },
              ),
            },
          },
        };
      })(),
      accepted: false,
    },
  ])("$name matches the shared strict schema", ({ input, accepted }) => {
    const shared = quickChatEventEnvelopeSchema.safeParse(input);
    const preload = cloneQuickChatEventEnvelope(input);

    expect(shared.success).toBe(accepted);
    expect(preload !== null).toBe(accepted);
    if (shared.success) {
      expect(preload).toEqual(shared.data);
    }
  });
});

describe("Task preload validator parity", () => {
  it.each(TOOL_NAME_VALUES)(
    "accepts the canonical %s tool in shared and preload validators",
    (name) => {
      const input = completedTaskEnvelope();
      if (input.event?.type !== "tool_completed") {
        throw new Error("invalid task fixture");
      }
      input.event.payload.name = name;

      expect(taskEventEnvelopeSchema.safeParse(input).success).toBe(true);
      expect(cloneTaskEventEnvelope(input)).toEqual(input);
    },
  );

  it.each([
    {
      name: "valid list_files envelope",
      input: completedTaskEnvelope(),
      accepted: true,
    },
    {
      name: "over-limit subscription identifier",
      input: completedTaskEnvelope("s".repeat(257)),
      accepted: false,
    },
    {
      name: "over-limit task prompt",
      input: {
        ...completedTaskEnvelope(),
        task: {
          ...completedTaskEnvelope().task,
          prompt: "x".repeat(100_001),
        },
      },
      accepted: false,
    },
    {
      name: "event payload with an extra key",
      input: {
        ...completedTaskEnvelope(),
        event: {
          ...completedTaskEnvelope().event,
          payload: {
            ...(completedTaskEnvelope().event?.payload ?? {}),
            extra: true,
          },
        },
      },
      accepted: false,
    },
    {
      name: "unknown tool name",
      input: {
        ...completedTaskEnvelope(),
        event: {
          ...completedTaskEnvelope().event,
          payload: {
            ...(completedTaskEnvelope().event?.payload ?? {}),
            name: "read_secrets",
          },
        },
      },
      accepted: false,
    },
    {
      name: "custom-prototype nested task object",
      input: {
        ...completedTaskEnvelope(),
        task: {
          ...completedTaskEnvelope().task,
          progress: withPrototype(
            completedTaskEnvelope().task.progress,
            { inherited: true },
          ),
        },
      },
      accepted: false,
    },
    {
      name: "oversized tool data collection",
      input: {
        ...completedTaskEnvelope(),
        event: {
          ...completedTaskEnvelope().event,
          payload: {
            ...(completedTaskEnvelope().event?.payload ?? {}),
            data: { paths: Array.from({ length: 501 }, () => "file") },
          },
        },
      },
      accepted: false,
    },
    {
      name: "oversized hostile tool result",
      input: {
        ...completedTaskEnvelope(),
        event: {
          ...completedTaskEnvelope().event,
          payload: {
            ...(completedTaskEnvelope().event?.payload ?? {}),
            content: "x".repeat(256 * 1024 + 1),
          },
        },
      },
      accepted: false,
    },
  ])("$name matches the shared strict schema", ({ input, accepted }) => {
    const shared = taskEventEnvelopeSchema.safeParse(input);
    const preload = cloneTaskEventEnvelope(input);

    expect(shared.success).toBe(accepted);
    expect(preload !== null).toBe(accepted);
    if (shared.success) {
      expect(preload).toEqual(shared.data);
    }
  });
});
