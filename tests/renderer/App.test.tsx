// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { createTaskRequestSchema } from "../../src/shared/ipc";
import type {
  StorageStatus,
  TaskDetail,
  ZoroApi,
} from "../../src/shared/ipc";

const project = {
  id: "project-1",
  name: "zoro-web-platform",
  canonicalPath: "/tmp/zoro-web-platform",
  lastOpenedAt: 100,
};

const provider = {
  id: "provider-1",
  name: "KIMI K3",
  kind: "kimi" as const,
  baseUrl: "https://api.moonshot.cn/v1",
  modelId: "kimi-k3",
  contextLength: 1_000_000,
  headers: {},
  keySuffix: "1234",
  isDefault: true,
  connectionStatus: "connected" as const,
  connectionMessage: null,
  lastTestedAt: 100,
  billingNote: "付费模型",
  dashboardUrl: "https://platform.kimi.com/",
  createdAt: 100,
  updatedAt: 100,
};

function detail(
  overrides: Partial<TaskDetail["task"]> = {},
): TaskDetail {
  return {
    task: {
      id: "task-1",
      projectId: project.id,
      title: "修复登录状态恢复",
      prompt: "修复登录状态恢复",
      status: "running",
      providerSnapshot: {
        providerId: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        modelId: provider.modelId,
        contextLength: provider.contextLength,
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
        percent: 64,
        elapsedSeconds: 678,
        remainingSeconds: 402,
        estimationState: "ready",
      },
      currentStepId: "step-2",
      activeSince: 1,
      pausedSince: null,
      pauseReason: null,
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    },
    project,
    steps: [
      {
        id: "step-1",
        taskId: "task-1",
        order: 0,
        title: "读取项目与分析需求",
        completionCriteria: "项目已检查",
        estimateSeconds: 120,
        actualSeconds: 90,
        observedFraction: 1,
        status: "completed",
      },
      {
        id: "step-2",
        taskId: "task-1",
        order: 1,
        title: "实现登录状态修复",
        completionCriteria: "状态恢复通过",
        estimateSeconds: 300,
        actualSeconds: null,
        observedFraction: 0.55,
        status: "running",
      },
    ],
    events: [],
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "修复登录状态恢复",
        createdAt: 1,
      },
      {
        id: "message-2",
        role: "assistant",
        content: "我正在检查状态恢复路径并运行验证。",
        createdAt: 2,
      },
    ],
    fileChanges: [],
  };
}

interface ApiOverrides {
  projects?: Partial<ZoroApi["projects"]>;
  tasks?: Partial<ZoroApi["tasks"]>;
  routing?: Partial<ZoroApi["routing"]>;
  quickChat?: Partial<ZoroApi["quickChat"]>;
  providers?: Partial<ZoroApi["providers"]>;
}

let storageStatusListener: ((status: StorageStatus) => void) | undefined;

function api(overrides: ApiOverrides = {}): ZoroApi {
  const base: ZoroApi = {
    app: {
      info: vi.fn(async () => ({
        portable: true as const,
        volumeName: "ZoroCoding Test",
        dataRoot: "/tmp/zoro-portable/ZoroCodingData",
        projectsRoot: "/tmp/zoro-portable/ZoroCodingData/Projects",
        storageAvailable: true,
        restartRequired: false,
      })),
      subscribeStorageStatus: vi.fn((listener) => {
        storageStatusListener = listener;
        return () => {
          storageStatusListener = undefined;
        };
      }),
    },
    projects: {
      select: vi.fn(async () => project),
      list: vi.fn(async () => []),
    },
    tasks: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => detail()),
      create: vi.fn(async () => detail()),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      addMessage: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      resolveApproval: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
    },
    routing: {
      get: vi.fn(async () => ({
        lightProviderId: provider.id,
        premiumProviderId: provider.id,
        updatedAt: 1,
      })),
      update: vi.fn(),
      preview: vi.fn<ZoroApi["routing"]["preview"]>(async ({ selection }) => ({
        decision: {
          intent: "complex_code",
          lane: "premium",
          executionMode: "agentic",
          confidence: "high",
          reasonCode: "project-change",
        },
        selectionMode: selection.mode,
        provider: {
          providerId: provider.id,
          name: provider.name,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          modelId: provider.modelId,
          contextLength: provider.contextLength,
        },
      })),
    },
    quickChat: {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => ({
        id: "quick-session-1",
        title: "新对话",
        createdAt: 1,
        updatedAt: 1,
      })),
      renameSession: vi.fn(),
      deleteSession: vi.fn(),
      listMessages: vi.fn(async () => []),
      send: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
    providers: {
      list: vi.fn(async () => [provider]),
      templates: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      test: vi.fn(),
      discoverModels: vi.fn(),
      testSaved: vi.fn(),
      setDefault: vi.fn(),
      remove: vi.fn(),
    },
  };
  return {
    ...base,
    ...overrides,
    projects: { ...base.projects, ...overrides.projects },
    tasks: { ...base.tasks, ...overrides.tasks },
    routing: { ...base.routing, ...overrides.routing },
    quickChat: { ...base.quickChat, ...overrides.quickChat },
    providers: { ...base.providers, ...overrides.providers },
  };
}

function installApi(mockApi: ZoroApi): void {
  Object.defineProperty(window, "zoro", {
    configurable: true,
    value: mockApi,
  });
}

function emitStorageStatus(status: StorageStatus): void {
  storageStatusListener?.(status);
}

afterEach(() => {
  storageStatusListener = undefined;
  vi.restoreAllMocks();
});

describe("ZoroCoding workbench", () => {
  it("blocks new work when the external drive becomes unavailable and until restart", async () => {
    installApi(api());
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "发起新任务" }),
    );
    expect(screen.getByRole("dialog", { name: "发起新任务" })).toBeVisible();

    await act(async () => {
      emitStorageStatus({
        storageAvailable: false,
        restartRequired: true,
        generation: 1,
      });
    });

    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "移动硬盘已断开",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "请重新连接移动硬盘并重新启动 ZoroCoding",
    );
    expect(
      screen.queryByRole("dialog", { name: "发起新任务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发起新任务" }),
    ).toBeDisabled();

    await act(async () => {
      emitStorageStatus({
        storageAvailable: true,
        restartRequired: true,
        generation: 2,
      });
    });

    expect(
      screen.getByRole("button", { name: "发起新任务" }),
    ).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toBeVisible();
  });

  it("creates a task and renders live progress", async () => {
    const mockApi = api();
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "发起新任务" }),
    );
    await user.click(screen.getByRole("button", { name: "选择项目" }));
    await user.type(
      screen.getByLabelText("任务要求"),
      "修复登录状态恢复",
    );
    await user.click(screen.getByRole("button", { name: "开始任务" }));

    expect(
      await screen.findByRole("heading", { name: "修复登录状态恢复" }),
    ).toBeVisible();
    expect(screen.getByText("预计剩余")).toBeVisible();
    expect(screen.getByText("06:42")).toBeVisible();
    expect(mockApi.tasks.create).toHaveBeenCalledWith({
      projectId: project.id,
      prompt: "修复登录状态恢复",
      selection: {
        mode: "auto",
      },
    });
    const submitted = vi.mocked(mockApi.tasks.create).mock.calls[0]?.[0];
    expect(createTaskRequestSchema.safeParse(submitted).success).toBe(true);
    expect(
      createTaskRequestSchema.safeParse({
        projectId: project.id,
        providerId: provider.id,
        prompt: "修复登录状态恢复",
      }).success,
    ).toBe(false);
  });

  it("loads an existing task and pauses it", async () => {
    const running = detail();
    const mockApi = api({
      projects: {
        list: vi.fn(async () => [project]),
        select: vi.fn(async () => project),
      },
      tasks: {
        list: vi.fn(async () => [running.task]),
        get: vi.fn(async () => running),
        pause: vi.fn(async () => {}),
        create: vi.fn(async () => running),
        resume: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        resolveApproval: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
      },
    });
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "暂停" }));

    expect(mockApi.tasks.pause).toHaveBeenCalledWith("task-1");
  });

  it("shows exact approval reasons and defaults Escape to denial", async () => {
    const awaiting = detail({
      status: "awaiting_approval",
      progress: {
        percent: 42,
        elapsedSeconds: 80,
        remainingSeconds: 120,
        estimationState: "paused",
      },
    });
    awaiting.events = [
      {
        id: "event-1",
        taskId: "task-1",
        type: "approval_requested",
        at: 10,
        payload: {
          approvalId: "approval-1",
          summary: "确认运行高风险命令：rm -rf build",
          reasons: ["命令会删除文件或目录"],
        },
      },
    ];
    const mockApi = api({
      projects: {
        list: vi.fn(async () => [project]),
        select: vi.fn(async () => project),
      },
      tasks: {
        list: vi.fn(async () => [awaiting.task]),
        get: vi.fn(async () => awaiting),
        create: vi.fn(async () => awaiting),
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        resolveApproval: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
      },
    });
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByText("确认运行高风险命令：rm -rf build"),
    ).toBeVisible();
    expect(screen.getByText("命令会删除文件或目录")).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(mockApi.tasks.resolveApproval).toHaveBeenCalledWith(
        "task-1",
        "deny",
      ),
    );
  });

  it("shows command failures in a dismissible error region", async () => {
    const mockApi = api({
      projects: {
        list: vi.fn(async () => {
          throw new Error("无法读取项目");
        }),
        select: vi.fn(async () => project),
      },
    });
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读取项目",
    );
    await user.click(screen.getByRole("button", { name: "关闭错误" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requires a second confirmation before canceling a task", async () => {
    const running = detail();
    const mockApi = api({
      projects: { list: vi.fn(async () => [project]) },
      tasks: {
        list: vi.fn(async () => [running.task]),
        get: vi.fn(async () => running),
      },
    });
    installApi(mockApi);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "取消任务" }),
    );
    expect(mockApi.tasks.cancel).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "取消任务" }));
    expect(mockApi.tasks.cancel).toHaveBeenCalledWith("task-1");
  });

  it("retries a failed task and sends supplemental requirements", async () => {
    const failed = detail({ status: "failed", currentStepId: null });
    failed.steps[1] = { ...failed.steps[1], status: "failed" };
    failed.events = [
      {
        id: "failed-event",
        taskId: "task-1",
        type: "task_failed",
        at: 3,
        payload: { message: "模型鉴权失败" },
      },
    ];
    const mockApi = api({
      projects: { list: vi.fn(async () => [project]) },
      tasks: {
        list: vi.fn(async () => [failed.task]),
        get: vi.fn(async () => failed),
      },
    });
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "重试失败步骤" }),
    );
    expect(mockApi.tasks.retry).toHaveBeenCalledWith("task-1");

    await user.type(screen.getByLabelText("继续输入要求"), "补充无障碍标签");
    await user.click(screen.getByRole("button", { name: "发送补充要求" }));
    expect(mockApi.tasks.addMessage).toHaveBeenCalledWith(
      "task-1",
      "补充无障碍标签",
    );
  });

  it("applies high-frequency output events incrementally without refetching task details", async () => {
    const running = detail();
    let listener:
      | Parameters<ZoroApi["tasks"]["subscribe"]>[0]
      | undefined;
    const get = vi.fn(async () => running);
    const mockApi = api({
      projects: { list: vi.fn(async () => [project]) },
      tasks: {
        list: vi.fn(async () => [running.task]),
        get,
        subscribe: vi.fn((nextListener) => {
          listener = nextListener;
          return () => {};
        }),
      },
    });
    installApi(mockApi);
    render(<App />);

    await screen.findByRole("heading", { name: "修复登录状态恢复" });
    await act(async () => {
      listener?.({
        subscriptionId: "test",
        task: { ...running.task, updatedAt: 3 },
        event: {
          id: "event-live",
          taskId: "task-1",
          type: "model_output",
          at: 3,
          payload: { text: "正在逐步分析登录状态" },
        },
      });
    });

    expect(
      await screen.findByText("正在逐步分析登录状态"),
    ).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("converts a media quick chat into a project task without preselecting a project", async () => {
    const mockApi = api({
      projects: {
        list: vi.fn(async () => [project]),
        select: vi.fn(async () => project),
      },
    });
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );
    const prompt = "用 Remotion 制作产品演示视频";
    await user.type(screen.getByLabelText("快速问答内容"), prompt);
    expect(
      await screen.findByText(
        "此处只能生成方案或代码，不能直接创建本地文件。",
      ),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "转为项目任务" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "发起新任务" }),
    ).toBeVisible();
    expect(screen.getByLabelText("任务要求")).toHaveValue(prompt);
    expect(screen.getByRole("button", { name: "选择项目" })).toHaveTextContent(
      "选择项目",
    );
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    expect(mockApi.projects.select).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "选择项目" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled(),
    );
  });

  it("does not expose a background task approval while Quick Chat is active", async () => {
    const running = detail();
    const awaiting = detail({
      status: "awaiting_approval",
      progress: {
        percent: 42,
        elapsedSeconds: 80,
        remainingSeconds: 120,
        estimationState: "paused",
      },
    });
    awaiting.events = [
      {
        id: "background-approval",
        taskId: awaiting.task.id,
        type: "approval_requested",
        at: 10,
        payload: {
          approvalId: "approval-background",
          summary: "后台任务请求运行高风险命令",
          reasons: ["会读取项目边界之外的位置"],
        },
      },
    ];
    let taskListener:
      | Parameters<ZoroApi["tasks"]["subscribe"]>[0]
      | undefined;
    const get = vi
      .fn<ZoroApi["tasks"]["get"]>()
      .mockResolvedValueOnce(running)
      .mockResolvedValue(awaiting);
    const mockApi = api({
      projects: { list: vi.fn(async () => [project]) },
      tasks: {
        list: vi.fn(async () => [running.task]),
        get,
        subscribe: vi.fn((listener) => {
          taskListener = listener;
          return () => {};
        }),
      },
    });
    installApi(mockApi);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );
    await act(async () => {
      taskListener?.({
        subscriptionId: "test",
        task: awaiting.task,
        event: awaiting.events[0],
      });
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    expect(
      screen.getByRole("heading", { name: "快速问答" }),
    ).toBeVisible();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText(project.canonicalPath)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "允许一次" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("会读取项目边界之外的位置"),
    ).not.toBeInTheDocument();
  });
});
