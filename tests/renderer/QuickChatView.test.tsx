// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import type {
  QuickChatMessage,
  QuickChatSession,
} from "../../src/shared/domain";
import type {
  QuickChatEventEnvelope,
  RoutingConfigView,
  StorageStatus,
  ProviderSummary,
  ZoroApi,
} from "../../src/shared/ipc";

const groq = {
  id: "groq",
  name: "Groq",
  kind: "openai-compatible" as const,
  baseUrl: "https://api.groq.com/openai/v1",
  modelId: "qwen/qwen3.6-27b",
  contextLength: 131_072,
  headers: {},
  keySuffix: "1234",
  isDefault: false,
  connectionStatus: "connected" as const,
  connectionMessage: null,
  lastTestedAt: 1,
  billingNote: "免费额度",
  dashboardUrl: "https://console.groq.com/keys",
  createdAt: 1,
  updatedAt: 1,
};

const kimi = {
  ...groq,
  id: "kimi",
  name: "KIMI K3",
  kind: "kimi" as const,
  baseUrl: "https://api.moonshot.cn/v1",
  modelId: "kimi-k3",
  contextLength: 1_000_000,
  isDefault: true,
};

const team = {
  ...groq,
  id: "team",
  name: "团队模型",
  baseUrl: "https://models.example.com/v1",
  modelId: "team-code",
  keySuffix: "team",
};

const session: QuickChatSession = {
  id: "session-1",
  title: "package.json 是什么",
  createdAt: 1,
  updatedAt: 2,
};

const completedUser: QuickChatMessage = {
  id: "user-1",
  sessionId: session.id,
  role: "user",
  content: "package.json 是什么？",
  providerSnapshot: null,
  routeDecision: null,
  status: "completed",
  errorMessage: null,
  createdAt: 3,
};

const completedAssistant: QuickChatMessage = {
  id: "assistant-1",
  sessionId: session.id,
  role: "assistant",
  content: "它是 Node.js 项目的清单文件。",
  providerSnapshot: {
    providerId: groq.id,
    name: groq.name,
    kind: groq.kind,
    baseUrl: groq.baseUrl,
    modelId: groq.modelId,
    contextLength: groq.contextLength,
  },
  routeDecision: {
    intent: "simple_code",
    lane: "light",
    executionMode: "read_only",
    confidence: "high",
    reasonCode: "code-explanation",
  },
  status: "completed",
  errorMessage: null,
  createdAt: 4,
};

interface InstallOptions {
  sessions?: QuickChatSession[];
  messages?: QuickChatMessage[];
  send?: ZoroApi["quickChat"]["send"];
  providers?: ZoroApi["providers"] extends {
    list(): Promise<infer Providers>;
  }
    ? Providers
    : never;
  routingConfig?: RoutingConfigView;
}

let quickChatListener:
  | ((event: QuickChatEventEnvelope) => void)
  | undefined;
let storageListener: ((status: StorageStatus) => void) | undefined;

function routeFor(prompt: string, provider: ProviderSummary = groq) {
  const media = /视频|画一只猫|svg|canvas|ffmpeg|manim/i.test(prompt);
  return {
    decision: {
      intent: media ? ("media_script" as const) : ("simple_code" as const),
      lane: media ? ("premium" as const) : ("light" as const),
      executionMode: media ? ("agentic" as const) : ("read_only" as const),
      confidence: "high" as const,
      reasonCode: media
        ? ("media-generation" as const)
        : ("code-explanation" as const),
    },
    selectionMode: "auto" as const,
    provider: {
      providerId: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      modelId: provider.modelId,
      contextLength: provider.contextLength,
    },
  };
}

function installApi(options: InstallOptions = {}): ZoroApi {
  const listedSessions = options.sessions ?? [];
  const listedMessages = options.messages ?? [];
  let configuredProviders = options.providers ?? [groq, kimi];
  let routingConfig = options.routingConfig ?? {
    lightProviderId: groq.id,
    premiumProviderId: kimi.id,
    updatedAt: 1,
  };
  const quickChat: ZoroApi["quickChat"] = {
    listSessions: vi.fn(async () => listedSessions),
    createSession: vi.fn(async () => session),
    renameSession: vi.fn(async (_sessionId, title) => ({
      ...session,
      title,
      updatedAt: 10,
    })),
    deleteSession: vi.fn(async () => {}),
    listMessages: vi.fn(async () => listedMessages),
    send: options.send ?? vi.fn(async () => completedAssistant),
    cancel: vi.fn(async () => {}),
    retry: vi.fn(async () => completedAssistant),
    subscribe: vi.fn((listener) => {
      quickChatListener = listener;
      return () => {
        quickChatListener = undefined;
      };
    }),
  };
  const api: ZoroApi = {
    app: {
      info: vi.fn(async () => ({
        portable: true as const,
        volumeName: "ZoroCoding Test",
        dataRoot: "/tmp/zoro/ZoroCodingData",
        projectsRoot: "/tmp/zoro/ZoroCodingData/Projects",
        storageAvailable: true,
        restartRequired: false,
      })),
      subscribeStorageStatus: vi.fn((listener) => {
        storageListener = listener;
        return () => {
          storageListener = undefined;
        };
      }),
    },
    projects: {
      select: vi.fn(async () => null),
      list: vi.fn(async () => []),
    },
    tasks: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      create: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      retry: vi.fn(),
      addMessage: vi.fn(),
      cancel: vi.fn(),
      resolveApproval: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
    routing: {
      get: vi.fn(async () => routingConfig),
      update: vi.fn(async (input) => {
        routingConfig = {
          ...input,
          updatedAt: routingConfig.updatedAt + 1,
        };
        return routingConfig;
      }),
      preview: vi.fn<ZoroApi["routing"]["preview"]>(async ({ prompt, selection }) => {
        const selected =
          selection.mode === "manual"
            ? configuredProviders.find(
                (provider) => provider.id === selection.providerId,
              )!
            : prompt.includes("视频")
              ? kimi
              : groq;
        return {
          ...routeFor(prompt, selected),
          selectionMode: selection.mode,
        };
      }),
    },
    quickChat,
    providers: {
      list: vi.fn(async () => [...configuredProviders]),
      templates: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      test: vi.fn(),
      discoverModels: vi.fn(),
      testSaved: vi.fn(),
      setDefault: vi.fn(),
      remove: vi.fn(async (id) => {
        configuredProviders = configuredProviders.filter(
          (provider) => provider.id !== id,
        );
      }),
    },
  };
  Object.defineProperty(window, "zoro", {
    configurable: true,
    value: api,
  });
  return api;
}

function emitQuickChat(event: QuickChatEventEnvelope["event"]): void {
  quickChatListener?.({ subscriptionId: "test", event });
}

afterEach(() => {
  quickChatListener = undefined;
  storageListener = undefined;
  vi.restoreAllMocks();
});

describe("no-project Quick Chat", () => {
  it("opens with zero projects and creates a first session without project authorization", async () => {
    const api = installApi();
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    expect(
      await screen.findByRole("heading", { name: "快速问答" }),
    ).toBeVisible();
    expect(api.quickChat.createSession).toHaveBeenCalledOnce();
    expect(api.projects.select).not.toHaveBeenCalled();
    expect(screen.queryByText(/项目路径|终端|权限|任务进度/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /打开进度|选择项目/ }),
    ).not.toBeInTheDocument();
  });

  it("loads persisted session history again after remount", async () => {
    const api = installApi({
      sessions: [session],
      messages: [completedUser, completedAssistant],
    });
    const user = userEvent.setup();
    const first = render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );
    expect(await screen.findByText(completedAssistant.content)).toBeVisible();
    first.unmount();
    expect(quickChatListener).toBeUndefined();

    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );
    expect(await screen.findByText(completedAssistant.content)).toBeVisible();
    expect(api.quickChat.listMessages).toHaveBeenCalledTimes(2);
  });

  it("loads an interrupted reply as idle and lets the user retry after restart", async () => {
    const interrupted: QuickChatMessage = {
      ...completedAssistant,
      id: "assistant-interrupted",
      content: "已生成的部分内容",
      status: "failed",
      errorMessage: "上次运行意外中断，可以重试这条回复。",
    };
    const api = installApi({
      sessions: [session],
      messages: [completedUser, interrupted],
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    expect(
      await screen.findByText("上次运行意外中断，可以重试这条回复。"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "取消回答" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "重试这条回复" }),
    );
    expect(api.quickChat.retry).toHaveBeenCalledWith({
      sessionId: session.id,
      messageId: interrupted.id,
      selection: { mode: "auto" },
    });
  });

  it("previews auto and manual routes, streams an answer, and reports the actual model", async () => {
    const api = installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    await user.type(
      screen.getByLabelText("快速问答内容"),
      "解释 package.json",
    );
    expect(await screen.findByText("轻量模型")).toBeVisible();
    expect(await screen.findByText("代码解释")).toBeVisible();
    expect(await screen.findByText("Groq · qwen/qwen3.6-27b")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "手动选择" }));
    await user.click(screen.getByRole("combobox", { name: "手动模型" }));
    await user.click(
      screen.getByRole("option", { name: "KIMI K3 · kimi-k3" }),
    );
    expect(await screen.findByText("KIMI K3 · kimi-k3")).toBeVisible();
    expect(screen.getByText("代码解释")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(api.quickChat.send).toHaveBeenCalledWith({
      sessionId: session.id,
      prompt: "解释 package.json",
      selection: { mode: "manual", providerId: kimi.id },
    });
    expect(screen.getByText("解释 package.json")).toBeVisible();

    const started: QuickChatMessage = {
      ...completedAssistant,
      id: "assistant-live",
      content: "",
      providerSnapshot: {
        ...completedAssistant.providerSnapshot!,
        providerId: kimi.id,
        name: kimi.name,
        kind: kimi.kind,
        baseUrl: kimi.baseUrl,
        modelId: kimi.modelId,
        contextLength: kimi.contextLength,
      },
      status: "streaming",
    };
    await act(async () => {
      emitQuickChat({ type: "message_started", message: started });
      emitQuickChat({
        type: "message_delta",
        sessionId: session.id,
        messageId: started.id,
        text: "正在",
      });
    });
    expect(screen.getByText("正在")).toBeVisible();

    await act(async () => {
      emitQuickChat({
        type: "message_completed",
        message: {
          ...started,
          content: "正在解释 package.json。",
          status: "completed",
        },
      });
    });
    expect(screen.getByText("正在解释 package.json。")).toBeVisible();
    expect(screen.getByText("KIMI K3 · kimi-k3")).toBeVisible();
  });

  it("removes a completed preview immediately when the prompt changes", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const input = screen.getByLabelText("快速问答内容");
    await user.type(input, "解释 package.json");
    expect(await screen.findByText("Groq · qwen/qwen3.6-27b")).toBeVisible();

    await user.clear(input);
    await user.type(input, "制作产品演示视频");
    expect(
      screen.queryByText("Groq · qwen/qwen3.6-27b"),
    ).not.toBeInTheDocument();
  });

  it("offers to convert an ordinary drawing request into a project task", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    await user.type(screen.getByLabelText("快速问答内容"), "画一只猫");

    await user.click(
      await screen.findByRole("button", { name: "转为项目任务" }),
    );
    expect(
      screen.getByRole("textbox", { name: "任务要求" }),
    ).toHaveValue("画一只猫");
  });

  it("offers project conversion for media creation but not media explanation", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const input = screen.getByLabelText("快速问答内容");
    await user.type(input, "Explain how to use Canvas");
    expect(
      screen.queryByRole("button", { name: "转为项目任务" }),
    ).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "Draw a Canvas illustration");
    expect(
      await screen.findByRole("button", { name: "转为项目任务" }),
    ).toBeVisible();
  });

  it("offers conversion for a separate media action but not a procedural explanation", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const input = screen.getByLabelText("快速问答内容");
    await user.type(input, "Explain how to create an SVG icon");
    expect(
      screen.queryByRole("button", { name: "转为项目任务" }),
    ).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(
      input,
      "Explain SVG and create one in this project",
    );
    expect(
      await screen.findByRole("button", { name: "转为项目任务" }),
    ).toBeVisible();

    await user.clear(input);
    await user.type(input, "请解释 SVG，然后生成一个图标");
    expect(
      await screen.findByRole("button", { name: "转为项目任务" }),
    ).toBeVisible();
  });

  it("keeps media tutorials in chat and converts coordinated creation of arbitrary objects", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const input = screen.getByLabelText("快速问答内容");
    await user.type(
      input,
      "Explain how to create an SVG icon and then make it responsive",
    );
    expect(
      screen.queryByRole("button", { name: "转为项目任务" }),
    ).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(
      input,
      "Explain SVG and create a logo in this project",
    );
    expect(
      await screen.findByRole("button", { name: "转为项目任务" }),
    ).toBeVisible();

    await user.clear(input);
    await user.type(input, "请解释 SVG，然后创建一个徽标");
    expect(
      await screen.findByRole("button", { name: "转为项目任务" }),
    ).toBeVisible();
  });

  it(
    "converts independent actions after tutorials while keeping tutorial steps in chat",
    async () => {
      installApi({ sessions: [session] });
      const user = userEvent.setup();
      render(<App />);
      await user.click(
        await screen.findByRole("button", { name: "快速问答" }),
      );

      const input = screen.getByLabelText("快速问答内容");
      await user.type(
        input,
        "Explain how to create an SVG icon and then make it responsive",
      );
      expect(
        screen.queryByRole("button", { name: "转为项目任务" }),
      ).not.toBeInTheDocument();

      for (const prompt of [
        "Explain how to create an SVG icon and then create a logo in this project",
        "Explain SVG and also create a logo in this project",
        "如何使用 SVG，然后创建一个徽标",
        "请解释 SVG，然后在项目中创建一个徽标",
        "请解释 SVG，然后帮我创建一个徽标",
      ]) {
        await user.clear(input);
        await user.type(input, prompt);
        expect(
          await screen.findByRole("button", { name: "转为项目任务" }),
        ).toBeVisible();
      }
    },
    15_000,
  );

  it("uses tutorial and project clause scope for media conversion", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const input = screen.getByLabelText("快速问答内容");
    await user.type(
      input,
      "Explain how to create an SVG icon and then make the logo responsive",
    );
    expect(
      screen.queryByRole("button", { name: "转为项目任务" }),
    ).not.toBeInTheDocument();

    for (const prompt of [
      "Explain SVG and then make it responsive in this project",
      "Explain SVG, and in this project create a logo",
      "Explain SVG, and for this project create a logo",
      "Explain SVG, then for this project save the icon",
      "请解释 SVG，然后创建一个徽标，并说明让它响应式的方法",
      "请解释 SVG，然后创建一个徽标，再介绍导出它的方法",
    ]) {
      await user.clear(input);
      await user.type(input, prompt);
      expect(
        await screen.findByRole("button", { name: "转为项目任务" }),
      ).toBeVisible();
    }
  });

  it("converts project-scoped file actions but not tutorial-only export", async () => {
    installApi({ sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const input = screen.getByLabelText("快速问答内容");
    await user.type(
      input,
      "How do I create an SVG diagram and then export it?",
    );
    expect(
      screen.queryByRole("button", { name: "转为项目任务" }),
    ).not.toBeInTheDocument();

    for (const prompt of [
      "How do I create an SVG icon and then export it to this project?",
      "Explain SVG and save the file in this project",
      "Explain SVG and integrate the icon into this project",
      "请解释 SVG，然后创建一个徽标，并请说明让它响应式的方法",
      "请解释 SVG，然后创建一个徽标，接着介绍导出它的方法",
    ]) {
      await user.clear(input);
      await user.type(input, prompt);
      expect(
        await screen.findByRole("button", { name: "转为项目任务" }),
      ).toBeVisible();
    }
  });

  it("cancels exact sessions and retries failed replies without losing failed-provider details", async () => {
    const failed: QuickChatMessage = {
      ...completedAssistant,
      id: "assistant-failed",
      status: "failed",
      content: "部分回复",
      errorMessage: "请求频率过高",
    };
    const api = installApi({
      sessions: [session],
      messages: [completedUser, failed],
      send: vi.fn(
        () =>
          new Promise<QuickChatMessage>(() => {
            // A real send remains pending until streaming completes or cancel settles it.
          }),
      ),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    expect(await screen.findByText("请求频率过高")).toBeVisible();
    expect(
      screen.getByText("实际模型：Groq · qwen/qwen3.6-27b"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "重试这条回复" }),
    );
    expect(api.quickChat.retry).toHaveBeenCalledWith({
      sessionId: session.id,
      messageId: failed.id,
      selection: { mode: "auto" },
    });

    await user.click(screen.getByRole("button", { name: "更换模型" }));
    expect(screen.getByRole("radio", { name: "手动选择" })).toBeChecked();
    expect(screen.getByLabelText("手动模型")).toBeVisible();

    await user.type(screen.getByLabelText("快速问答内容"), "继续说明");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "取消回答" }));
    expect(api.quickChat.cancel).toHaveBeenCalledWith(session.id);
  });

  it("keeps persisted history but clears volatile streaming text when storage disconnects", async () => {
    installApi({
      sessions: [session],
      messages: [completedUser, completedAssistant],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );

    const streaming: QuickChatMessage = {
      ...completedAssistant,
      id: "assistant-streaming",
      content: "",
      status: "streaming",
    };
    await act(async () => {
      emitQuickChat({ type: "message_started", message: streaming });
      emitQuickChat({
        type: "message_delta",
        sessionId: session.id,
        messageId: streaming.id,
        text: "尚未保存的片段",
      });
    });
    expect(screen.getByText("尚未保存的片段")).toBeVisible();

    await act(async () => {
      storageListener?.({
        storageAvailable: false,
        restartRequired: true,
        generation: 1,
      });
    });

    expect(screen.getByText(completedAssistant.content)).toBeInTheDocument();
    expect(screen.queryByText("尚未保存的片段")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("refreshes routing roles after saving settings and returning to Quick Chat", async () => {
    const api = installApi({
      sessions: [session],
      routingConfig: {
        lightProviderId: null,
        premiumProviderId: kimi.id,
        updatedAt: 1,
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );
    await user.type(
      screen.getByLabelText("快速问答内容"),
      "解释 package.json",
    );
    expect(await screen.findByText("轻量模型未配置")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "前往设置" }));

    expect(
      await screen.findByRole("heading", { name: "自动模型路由" }),
    ).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "轻量模型" }));
    await user.click(
      screen.getByRole("option", {
        name: "Groq · qwen/qwen3.6-27b",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "保存自动模型路由" }),
    );
    await waitFor(() =>
      expect(api.routing.update).toHaveBeenCalledWith({
        lightProviderId: groq.id,
        premiumProviderId: kimi.id,
      }),
    );

    await user.click(screen.getByRole("button", { name: "快速问答" }));
    await waitFor(() =>
      expect(screen.queryByText("轻量模型未配置")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Groq · qwen/qwen3.6-27b")).toBeVisible();
  });

  it("returns an invalid manual Quick Chat selection to auto after that provider is deleted", async () => {
    const api = installApi({
      sessions: [session],
      providers: [groq, kimi, team],
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "快速问答" }),
    );
    await user.click(screen.getByRole("radio", { name: "手动选择" }));
    await user.click(screen.getByRole("combobox", { name: "手动模型" }));
    await user.click(
      screen.getByRole("option", { name: "团队模型 · team-code" }),
    );
    await user.type(
      screen.getByLabelText("快速问答内容"),
      "解释 package.json",
    );
    expect(await screen.findByText("团队模型 · team-code")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "设置与模型" }));
    await user.click(
      await screen.findByRole("button", { name: "删除团队模型" }),
    );
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(api.providers.remove).toHaveBeenCalledWith(team.id),
    );

    await user.click(screen.getByRole("button", { name: "快速问答" }));
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: "自动选择（推荐）" }),
      ).toBeChecked(),
    );
    expect(screen.queryByLabelText("手动模型")).not.toBeInTheDocument();
  });
});
