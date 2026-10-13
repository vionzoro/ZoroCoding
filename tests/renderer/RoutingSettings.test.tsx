// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewTaskDialog } from "../../src/renderer/components/NewTaskDialog";
import { SettingsView } from "../../src/renderer/components/SettingsView";
import { Workbench } from "../../src/renderer/components/Workbench";
import type { ProviderSummary, ZoroApi } from "../../src/shared/ipc";

const project = {
  id: "project-1",
  name: "zoro-web-platform",
  canonicalPath: "/tmp/zoro-web-platform",
  lastOpenedAt: 1,
};

const groq: ProviderSummary = {
  id: "groq",
  name: "Groq",
  kind: "openai-compatible",
  baseUrl: "https://api.groq.com/openai/v1",
  modelId: "qwen/qwen3.6-27b",
  contextLength: 131_072,
  headers: {},
  keySuffix: "roqq",
  isDefault: true,
  connectionStatus: "connected",
  connectionMessage: null,
  lastTestedAt: 1,
  billingNote: "免费额度",
  dashboardUrl: "https://console.groq.com/keys",
  createdAt: 1,
  updatedAt: 1,
};

const kimi: ProviderSummary = {
  id: "kimi",
  name: "KIMI K3",
  kind: "kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  modelId: "kimi-k3",
  contextLength: 1_000_000,
  headers: {},
  keySuffix: "k3x9",
  isDefault: false,
  connectionStatus: "connected",
  connectionMessage: null,
  lastTestedAt: 1,
  billingNote: "付费模型",
  dashboardUrl: "https://platform.kimi.com/",
  createdAt: 2,
  updatedAt: 2,
};

function snapshot(provider: ProviderSummary) {
  return {
    providerId: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    contextLength: provider.contextLength,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installApi(
  routing: Partial<ZoroApi["routing"]> = {},
): ZoroApi["routing"] {
  const api: ZoroApi = {
    integrations: { get: vi.fn(), update: vi.fn() },
    app: {
      info: vi.fn(async () => ({
        portable: true,
        volumeName: "ZoroCoding Test",
        dataRoot: "/tmp/data",
        projectsRoot: "/tmp/projects",
        storageAvailable: true,
        restartRequired: false,
      })),
      subscribeStorageStatus: vi.fn(() => () => {}),
    },
    projects: { list: vi.fn(async () => [project]), select: vi.fn() },
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
      get: vi.fn(async () => ({
        lightProviderId: groq.id,
        premiumProviderId: kimi.id,
        updatedAt: 1,
      })),
      update: vi.fn(async (input) => ({ ...input, updatedAt: 2 })),
      preview: vi.fn(async ({ prompt, selection }) => {
        const provider =
          selection.mode === "manual"
            ? [groq, kimi].find((item) => item.id === selection.providerId)!
            : prompt.includes("修改")
              ? kimi
              : groq;
        const isMutation = prompt.includes("修改");
        return {
          decision: {
            intent: isMutation ? "complex_code" : "simple_code",
            lane: isMutation ? "premium" : "light",
            executionMode: isMutation ? "agentic" : "read_only",
            confidence: "high",
            reasonCode: isMutation ? "project-change" : "code-explanation",
          },
          selectionMode: selection.mode,
          provider: snapshot(provider),
        };
      }),
      ...routing,
    },
    quickChat: {
      listSessions: vi.fn(),
      createSession: vi.fn(),
      renameSession: vi.fn(),
      deleteSession: vi.fn(),
      listMessages: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
    providers: {
      list: vi.fn(async () => [groq, kimi]),
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
  Object.defineProperty(window, "zoro", { configurable: true, value: api });
  return api.routing;
}

afterEach(() => vi.restoreAllMocks());

describe("automatic routing", () => {
  it("previews an automatic route and submits only the user selection", async () => {
    installApi();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <NewTaskDialog
        projects={[project]}
        providers={[groq, kimi]}
        onAuthorizeProject={vi.fn(async () => project)}
        onSubmit={onSubmit}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "自动选择（推荐）" }),
    ).toBeChecked();
    await user.type(screen.getByLabelText("任务要求"), "解释 package.json");
    expect(await screen.findByText("Groq · qwen/qwen3.6-27b")).toBeVisible();
    expect(screen.getByText("只读问答")).toBeVisible();

    await user.clear(screen.getByLabelText("任务要求"));
    await user.type(screen.getByLabelText("任务要求"), "修改登录并运行测试");
    expect(await screen.findByText("KIMI K3 · kimi-k3")).toBeVisible();
    expect(screen.getByText("完整执行")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "手动选择" }));
    await user.click(screen.getByRole("combobox", { name: "手动模型" }));
    await user.click(
      screen.getByRole("option", {
        name: "Groq · qwen/qwen3.6-27b",
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "手动模型" }),
    ).toHaveTextContent("Groq · qwen/qwen3.6-27b");
    expect(screen.getByText("完整执行")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(onSubmit).toHaveBeenCalledWith({
      projectId: project.id,
      prompt: "修改登录并运行测试",
      selection: { mode: "manual", providerId: groq.id },
    });
  });

  it("uses an accessible keyboard-operated custom model selector", async () => {
    installApi();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <NewTaskDialog
        projects={[project]}
        providers={[groq, kimi]}
        onAuthorizeProject={vi.fn(async () => project)}
        onSubmit={vi.fn()}
        onClose={onClose}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog").querySelector("form")).toHaveAttribute(
      "autocomplete",
      "off",
    );
    await user.click(screen.getByRole("radio", { name: "手动选择" }));
    const trigger = screen.getByRole("combobox", { name: "手动模型" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("listbox", { name: "手动模型" })).toBeVisible();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(trigger).toHaveTextContent("KIMI K3 · kimi-k3");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.keyboard(" ");
    expect(screen.getByRole("listbox", { name: "手动模型" })).toBeVisible();
    await user.keyboard("{ArrowUp} ");
    expect(trigger).toHaveTextContent("Groq · qwen/qwen3.6-27b");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.keyboard(" ");
    expect(screen.getByRole("listbox", { name: "手动模型" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("listbox", { name: "手动模型" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard(" ");
    expect(screen.getByRole("listbox", { name: "手动模型" })).toBeVisible();
    await user.click(screen.getByRole("heading", { name: "发起新任务" }));
    expect(
      screen.queryByRole("listbox", { name: "手动模型" }),
    ).not.toBeInTheDocument();
  });

  it("blocks a missing route role and links to settings", async () => {
    installApi({
      get: vi.fn(async () => ({
        lightProviderId: null,
        premiumProviderId: kimi.id,
        updatedAt: 1,
      })),
    });
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        projects={[project]}
        providers={[groq, kimi]}
        onAuthorizeProject={vi.fn(async () => project)}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    await user.type(screen.getByLabelText("任务要求"), "解释 package.json");
    expect(await screen.findByText("轻量模型未配置")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "前往设置" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("renders route preview failures with the dedicated error class", async () => {
    installApi({
      preview: vi.fn(async () => {
        throw new Error("preview failed");
      }),
    });
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        projects={[project]}
        providers={[groq, kimi]}
        onAuthorizeProject={vi.fn(async () => project)}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("任务要求"), "解释 package.json");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("route-preview-error");
    expect(alert).toHaveTextContent("无法预览模型路由");
  });

  it("ignores a stale route preview after the prompt changes", async () => {
    const first = deferred<Awaited<ReturnType<ZoroApi["routing"]["preview"]>>>();
    const second = deferred<Awaited<ReturnType<ZoroApi["routing"]["preview"]>>>();
    const preview = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    installApi({ preview });
    const user = userEvent.setup();
    render(
      <NewTaskDialog
        projects={[project]}
        providers={[groq, kimi]}
        onAuthorizeProject={vi.fn(async () => project)}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const prompt = screen.getByLabelText("任务要求");
    await user.type(prompt, "解释 package.json");
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    await user.clear(prompt);
    await user.type(prompt, "修改登录并运行测试");
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({
        decision: {
          intent: "complex_code",
          lane: "premium",
          executionMode: "agentic",
          confidence: "high",
          reasonCode: "project-change",
        },
        selectionMode: "auto",
        provider: snapshot(kimi),
      });
      await second.promise;
    });
    expect(await screen.findByText("KIMI K3 · kimi-k3")).toBeVisible();

    await act(async () => {
      first.resolve({
        decision: {
          intent: "simple_code",
          lane: "light",
          executionMode: "read_only",
          confidence: "high",
          reasonCode: "code-explanation",
        },
        selectionMode: "auto",
        provider: snapshot(groq),
      });
      await first.promise;
    });
    expect(screen.getByText("KIMI K3 · kimi-k3")).toBeVisible();
  });
});

describe("routing settings and task history", () => {
  it("keeps a disabled custom routing selector closed", async () => {
    installApi();
    const user = userEvent.setup();
    render(<SettingsView storageReady={false} />);

    const trigger = await screen.findByRole("combobox", {
      name: "轻量模型",
    });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(
      screen.queryByRole("listbox", { name: "轻量模型" }),
    ).not.toBeInTheDocument();
  });

  it("loads and saves both automatic routing roles without exposing credentials", async () => {
    const routing = installApi();
    const onProvidersChanged = vi.fn();
    const user = userEvent.setup();
    render(<SettingsView onProvidersChanged={onProvidersChanged} />);

    expect(await screen.findByRole("heading", { name: "自动模型路由" })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText("轻量模型")).toHaveValue(groq.id);
      expect(screen.getByLabelText("高级模型")).toHaveValue(kimi.id);
    });
    expect(document.body.textContent).not.toContain("secretRef");
    expect(document.body.textContent).not.toContain("private-test-key");

    await user.click(screen.getByRole("combobox", { name: "高级模型" }));
    await user.click(
      screen.getByRole("option", {
        name: "Groq · qwen/qwen3.6-27b",
      }),
    );
    await user.click(screen.getByRole("button", { name: "保存自动模型路由" }));
    expect(routing.update).toHaveBeenCalledWith({
      lightProviderId: groq.id,
      premiumProviderId: groq.id,
    });
    expect(onProvidersChanged).toHaveBeenCalledOnce();
  });

  it("does not save automatic routing until both roles are selected", async () => {
    installApi({
      get: vi.fn(async () => ({
        lightProviderId: null,
        premiumProviderId: kimi.id,
        updatedAt: 1,
      })),
    });
    render(<SettingsView />);

    expect(await screen.findByLabelText("轻量模型")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "保存自动模型路由" }),
    ).toBeDisabled();
  });

  it("renders immutable routing data from the historical task snapshot", () => {
    render(
      <Workbench
        detail={{
          task: {
            id: "task-1",
            projectId: project.id,
            title: "修改登录",
            prompt: "修改登录",
            status: "completed",
            providerSnapshot: snapshot(kimi),
            routeDecision: {
              intent: "complex_code",
              lane: "premium",
              executionMode: "agentic",
              confidence: "high",
              reasonCode: "project-change",
            },
            selectionMode: "auto",
            executionMode: "agentic",
            progress: {
              percent: 100,
              elapsedSeconds: 1,
              remainingSeconds: null,
              estimationState: "ready",
            },
            currentStepId: null,
            activeSince: null,
            pausedSince: null,
            pauseReason: null,
            createdAt: 1,
            updatedAt: 1,
          },
          project,
          steps: [],
          events: [],
          messages: [],
          fileChanges: [],
        }}
        hasProjects
        onNewTask={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onAddMessage={vi.fn(async () => {})}
        onCancel={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );

    expect(screen.getByText("已识别：复杂代码")).toBeVisible();
    expect(screen.getByText("选择方式：自动")).toBeVisible();
    expect(screen.getByText("实际模型：KIMI K3 · kimi-k3")).toBeVisible();
    expect(screen.getByText("执行方式：完整执行")).toBeVisible();
  });
});
