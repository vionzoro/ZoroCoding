// @vitest-environment jsdom

import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/components/SettingsView";
import type { ProviderTemplate } from "../../src/shared/domain";
import type {
  AppInfo,
  ProviderSummary,
  StorageStatus,
  ZoroApi,
} from "../../src/shared/ipc";

const kimi: ProviderSummary = {
  id: "kimi",
  name: "KIMI K3",
  kind: "kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  modelId: "kimi-k3",
  contextLength: 1_000_000,
  headers: {},
  keySuffix: "K3x9",
  isDefault: true,
  connectionStatus: "connected",
  connectionMessage: null,
  lastTestedAt: 1_722_470_400_000,
  billingNote: "付费模型",
  dashboardUrl: "https://platform.kimi.com/",
  createdAt: 1,
  updatedAt: 1,
};

const team: ProviderSummary = {
  id: "team",
  name: "团队模型",
  kind: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  modelId: "team-code",
  contextLength: 128_000,
  headers: {},
  keySuffix: "cret",
  isDefault: false,
  connectionStatus: "untested",
  connectionMessage: null,
  lastTestedAt: null,
  billingNote: "按服务商规则计费",
  dashboardUrl: "https://api.example.com/dashboard",
  createdAt: 2,
  updatedAt: 2,
};

const providerTemplates: ProviderTemplate[] = [
  {
    id: "kimi-k3",
    name: "KIMI K3",
    kind: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    suggestedModelId: "kimi-k3",
    requiresDiscovery: false,
    contextLength: 1_000_000,
    billingNote: "付费模型",
    dashboardUrl: "https://platform.kimi.com/",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    suggestedModelId: "qwen/qwen3.6-27b",
    requiresDiscovery: false,
    contextLength: 131_072,
    billingNote: "免费额度",
    dashboardUrl: "https://console.groq.com/keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    suggestedModelId: "gemini-3.5-flash",
    requiresDiscovery: false,
    contextLength: 1_000_000,
    billingNote: "免费层受地区限制",
    dashboardUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    suggestedModelId: "openrouter/free",
    requiresDiscovery: false,
    contextLength: 200_000,
    billingNote: "免费模型限额",
    dashboardUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    requiresDiscovery: true,
    contextLength: 131_072,
    billingNote: "免费额度",
    dashboardUrl: "https://cloud.cerebras.ai/",
  },
  {
    id: "sambanova",
    name: "SambaNova",
    kind: "openai-compatible",
    baseUrl: "https://api.sambanova.ai/v1",
    requiresDiscovery: true,
    contextLength: 131_072,
    billingNote: "免费额度",
    dashboardUrl: "https://cloud.sambanova.ai/apis",
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    suggestedModelId: "mistral-small-latest",
    requiresDiscovery: false,
    contextLength: 131_072,
    billingNote: "免费试用额度",
    dashboardUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    requiresDiscovery: true,
    contextLength: 131_072,
    billingNote: "免费试用额度",
    dashboardUrl: "https://build.nvidia.com/settings/api-keys",
  },
  {
    id: "zhipu",
    name: "智谱 BigModel",
    kind: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requiresDiscovery: true,
    contextLength: 131_072,
    billingNote: "免费额度与计费规则由服务商决定",
    dashboardUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresDiscovery: false,
    contextLength: 131_072,
    billingNote: "本机运行，不产生 API 费用",
    dashboardUrl: "https://ollama.com/",
  },
];

const defaultAppInfo: AppInfo = {
  portable: true,
  volumeName: "ZoroCoding Test",
  dataRoot: "/tmp/zoro-portable/ZoroCodingData",
  projectsRoot: "/tmp/zoro-portable/ZoroCodingData/Projects",
  storageAvailable: true,
  restartRequired: false,
};

interface ProviderInstallOptions {
  appInfo?: AppInfo;
  templates?: ProviderTemplate[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installProviders(
  initial: ProviderSummary[] = [kimi],
  options: ProviderInstallOptions = {},
) {
  let storageListener: ((status: StorageStatus) => void) | undefined;
  const providers: ZoroApi["providers"] = {
    list: vi.fn(async () => initial),
    templates: vi.fn(async () => options.templates ?? providerTemplates),
    create: vi.fn(async (input) => ({
      ...team,
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      contextLength: input.contextLength,
      headers: input.headers,
      isDefault: input.isDefault,
      keySuffix: input.apiKey.slice(-4),
    })),
    update: vi.fn(async (id, input) => ({
      ...team,
      id,
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      contextLength: input.contextLength,
      headers: input.headers,
      isDefault: input.isDefault,
    })),
    test: vi.fn(async () => ({ ok: true, latencyMs: 88 })),
    discoverModels: vi.fn(async () => [
      { id: "code-large", label: "code-large" },
      { id: "code-small", label: "code-small" },
    ]),
    testSaved: vi.fn(async () => ({ ok: true, latencyMs: 64 })),
    setDefault: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "zoro", {
    configurable: true,
    value: {
      integrations: { get: vi.fn(), update: vi.fn() },
      app: {
        info: vi.fn(async () => options.appInfo ?? defaultAppInfo),
        subscribeStorageStatus: vi.fn((listener) => {
          storageListener = listener;
          return () => {
            storageListener = undefined;
          };
        }),
      },
      projects: {
        list: vi.fn(async () => []),
        select: vi.fn(async () => null),
      },
      tasks: {
        list: vi.fn(async () => []),
        get: vi.fn(),
        create: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(),
        resolveApproval: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      routing: {
        get: vi.fn(async () => ({
          lightProviderId: initial[0]?.id ?? null,
          premiumProviderId: initial[0]?.id ?? null,
          updatedAt: 1,
        })),
        update: vi.fn(async (input) => ({ ...input, updatedAt: 2 })),
        preview: vi.fn(),
      },
      providers,
    } satisfies ZoroApi,
  });
  return {
    providers,
    emitStorageStatus(status: StorageStatus) {
      storageListener?.(status);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsView", () => {
  it("shows the locked portable locations", async () => {
    installProviders([kimi], {
      appInfo: {
        portable: true,
        volumeName: "ORICO",
        dataRoot: "/Volumes/ORICO/ZoroCodingData",
        projectsRoot: "/Volumes/ORICO/ZoroCodingData/Projects",
        storageAvailable: true,
        restartRequired: false,
      },
    });

    render(<SettingsView />);

    expect(await screen.findByText("磁盘名称")).toBeVisible();
    expect(screen.getByText("ORICO", { selector: "dd" })).toBeVisible();
    expect(await screen.findByText("ORICO/ZoroCodingData")).toBeVisible();
    expect(screen.getByText("项目只能存放在 Projects")).toBeVisible();
    expect(screen.getByText("移动硬盘可用")).toBeVisible();
  });

  it("offers all credential-free quick configuration templates", async () => {
    installProviders();
    render(<SettingsView />);

    for (const name of [
      "KIMI K3",
      "Groq",
      "Google Gemini",
      "OpenRouter",
      "Cerebras",
      "SambaNova",
      "Mistral",
      "NVIDIA NIM",
      "智谱 BigModel",
      "Ollama",
    ]) {
      expect(
        await screen.findByRole("button", { name: `配置 ${name}` }),
      ).toBeVisible();
    }
  });

  it("prefills the Kimi template without exposing a key", async () => {
    installProviders();
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(
      await screen.findByRole("button", { name: "配置 KIMI K3" }),
    );

    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "https://api.moonshot.cn/v1",
    );
    expect(screen.getByLabelText("模型 ID")).toHaveValue("kimi-k3");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("discovers models after a key is entered and lets the user select one", async () => {
    const { providers } = installProviders();
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(
      await screen.findByRole("button", { name: "配置 Cerebras" }),
    );
    await user.type(screen.getByLabelText("API Key"), "private-test-key");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "获取可用模型" }));

    expect(providers.discoverModels).toHaveBeenCalledWith({
      baseUrl: "https://api.cerebras.ai/v1",
      apiKey: "private-test-key",
      headers: {},
    });
    const modelSelector = await screen.findByRole("combobox", {
      name: "模型 ID",
    });
    await user.click(modelSelector);
    await user.click(
      screen.getByRole("option", { name: "code-large" }),
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it.each(["API Key", "Base URL", "请求头"] as const)(
    "ignores a stale discovery response after %s changes",
    async (changedField) => {
      const pending = deferred<Array<{ id: string; label: string }>>();
      const { providers } = installProviders();
      vi.mocked(providers.discoverModels).mockReturnValueOnce(pending.promise);
      const user = userEvent.setup();
      render(<SettingsView />);

      await user.click(
        await screen.findByRole("button", { name: "配置 Cerebras" }),
      );
      await user.type(screen.getByLabelText("API Key"), "key-a");
      if (changedField === "请求头") {
        await user.click(screen.getByRole("button", { name: "添加请求头" }));
        await user.type(screen.getByLabelText("请求头名称 1"), "X-Team");
        await user.type(screen.getByLabelText("请求头值 1"), "alpha");
      }
      await user.click(screen.getByRole("button", { name: "获取可用模型" }));
      await waitFor(() =>
        expect(providers.discoverModels).toHaveBeenCalledTimes(1),
      );

      if (changedField === "API Key") {
        await user.clear(screen.getByLabelText("API Key"));
        await user.type(screen.getByLabelText("API Key"), "key-b");
      } else if (changedField === "Base URL") {
        await user.clear(screen.getByLabelText("Base URL"));
        await user.type(
          screen.getByLabelText("Base URL"),
          "https://api.example.com/v1",
        );
      } else {
        await user.clear(screen.getByLabelText("请求头值 1"));
        await user.type(screen.getByLabelText("请求头值 1"), "beta");
      }

      await act(async () => {
        pending.resolve([{ id: "stale-model", label: "stale-model" }]);
        await pending.promise;
      });

      expect(
        screen.queryByRole("option", { name: "stale-model" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("模型 ID")).toHaveValue("");
      expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
      expect(providers.create).not.toHaveBeenCalled();
    },
  );

  it("keeps the newest discovery when an older request has the same final identity", async () => {
    const older = deferred<Array<{ id: string; label: string }>>();
    const newer = deferred<Array<{ id: string; label: string }>>();
    const { providers } = installProviders();
    vi.mocked(providers.discoverModels)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(
      await screen.findByRole("button", { name: "配置 Cerebras" }),
    );
    await user.type(screen.getByLabelText("API Key"), "key-a");
    await user.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() =>
      expect(providers.discoverModels).toHaveBeenCalledTimes(1),
    );

    await user.clear(screen.getByLabelText("API Key"));
    await user.type(screen.getByLabelText("API Key"), "key-b");
    await user.clear(screen.getByLabelText("API Key"));
    await user.type(screen.getByLabelText("API Key"), "key-a");
    await user.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() =>
      expect(providers.discoverModels).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      newer.resolve([{ id: "fresh-model", label: "fresh-model" }]);
      await newer.promise;
    });
    const modelSelector = screen.getByRole("combobox", { name: "模型 ID" });
    await user.click(modelSelector);
    await user.click(
      screen.getByRole("option", { name: "fresh-model" }),
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();

    await act(async () => {
      older.resolve([{ id: "stale-model", label: "stale-model" }]);
      await older.promise;
    });

    expect(modelSelector).toHaveValue("fresh-model");
    expect(modelSelector).toHaveTextContent("fresh-model");
    expect(
      screen.queryByRole("option", { name: "stale-model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "stale-model" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("fresh-model");
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("shows connection health without rendering secret material", async () => {
    installProviders([kimi]);
    render(<SettingsView />);

    expect(await screen.findByText("连接正常")).toBeVisible();
    const providerRow = screen.getByRole("row", { name: /KIMI K3/ });
    expect(within(providerRow).getByText("••••K3x9")).toBeVisible();
    expect(within(providerRow).getByText("付费模型")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "打开 KIMI K3 服务后台" }),
    ).toHaveAttribute("href", "https://platform.kimi.com/");
    expect(document.body.textContent).not.toContain("private-test-key");
  });

  it("retests a saved provider and refreshes its persisted health", async () => {
    const untestedKimi: ProviderSummary = {
      ...kimi,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
    };
    const { providers } = installProviders([untestedKimi]);
    vi.mocked(providers.list)
      .mockResolvedValueOnce([untestedKimi])
      .mockResolvedValueOnce([kimi]);
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("尚未测试")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "测试 KIMI K3 连接" }),
    );

    await waitFor(() =>
      expect(providers.testSaved).toHaveBeenCalledWith("kimi"),
    );
    expect(await screen.findByText("连接正常")).toBeVisible();
  });

  it("adds and tests a compatible provider", async () => {
    const { providers } = installProviders();
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(
      await screen.findByRole("button", { name: "添加模型 API" }),
    );
    await user.type(screen.getByLabelText("名称"), "团队模型");
    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(
      screen.getByLabelText("Base URL"),
      "https://api.example.com/v1",
    );
    await user.clear(screen.getByLabelText("模型 ID"));
    await user.type(screen.getByLabelText("模型 ID"), "team-code");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("连接成功")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("团队模型")).toBeVisible();
    expect(providers.test).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.example.com/v1",
        modelId: "team-code",
        apiKey: "secret",
      }),
    );
    expect(providers.create).toHaveBeenCalled();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.getByText("••••cret")).toBeVisible();
  });

  it("rejects insecure remote URLs and sensitive custom headers", async () => {
    installProviders();
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(
      await screen.findByRole("button", { name: "添加模型 API" }),
    );
    await user.type(screen.getByLabelText("名称"), "不安全模型");
    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(
      screen.getByLabelText("Base URL"),
      "http://api.example.com/v1",
    );
    await user.clear(screen.getByLabelText("模型 ID"));
    await user.type(screen.getByLabelText("模型 ID"), "unsafe");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.click(screen.getByRole("button", { name: "添加请求头" }));
    await user.type(screen.getByLabelText("请求头名称 1"), "Authorization");
    await user.type(screen.getByLabelText("请求头值 1"), "Bearer leaked");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "远程 API 必须使用 HTTPS",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "不能自定义 Authorization",
    );
  });

  it("sets a provider as default", async () => {
    const { providers } = installProviders([kimi, team]);
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(
      await screen.findByRole("button", {
        name: "将团队模型设为默认",
      }),
    );

    expect(providers.setDefault).toHaveBeenCalledWith("team");
  });

  it("names the provider before deletion and removes it after confirmation", async () => {
    const { providers } = installProviders([kimi, team]);
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(
      await screen.findByRole("button", { name: "删除团队模型" }),
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent("团队模型");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(providers.remove).toHaveBeenCalledWith("team"),
    );
    expect(screen.queryByText("团队模型")).not.toBeInTheDocument();
  });

  it("disables every provider mutation while storage is unavailable", async () => {
    const { providers } = installProviders([kimi, team], {
      appInfo: {
        ...defaultAppInfo,
        storageAvailable: false,
        restartRequired: true,
      },
    });
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(
      await screen.findByRole("button", { name: "添加模型 API" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "配置 KIMI K3" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "测试 KIMI K3 连接" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑KIMI K3" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除KIMI K3" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "将团队模型设为默认" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "删除KIMI K3" }));
    expect(providers.create).not.toHaveBeenCalled();
    expect(providers.update).not.toHaveBeenCalled();
    expect(providers.test).not.toHaveBeenCalled();
    expect(providers.testSaved).not.toHaveBeenCalled();
    expect(providers.setDefault).not.toHaveBeenCalled();
    expect(providers.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
