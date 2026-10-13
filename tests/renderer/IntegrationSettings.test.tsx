// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationSettings } from "../../src/renderer/components/IntegrationSettings";
import { integrationOptionsSchema, type IntegrationSettingsView, type ZoroApi } from "../../src/shared/ipc";

const projects = [
  { id: "first", name: "第一个项目", canonicalPath: "private-project", lastOpenedAt: 1 },
  { id: "second", name: "第二个项目", canonicalPath: "other-private-project", lastOpenedAt: 2 },
];

function install(initial: Partial<IntegrationSettingsView> = {}) {
  const api: ZoroApi["integrations"] = {
    get: vi.fn(async (id) => ({ id, enabled: false, endpoint: "", keySuffix: "", updatedAt: 0, ...initial })),
    update: vi.fn(async (input) => ({
      id: input.id, enabled: input.enabled ?? false, endpoint: input.endpoint ?? "",
      options: integrationOptionsSchema.parse(input.options ?? {}),
      keySuffix: input.token ? input.token.slice(-4) : "", updatedAt: 1,
    })),
  };
  Object.defineProperty(window, "zoro", { configurable: true, value: { integrations: api } });
  return api;
}

async function memoryCard() {
  const card = screen.getByRole("region", { name: "外部记忆" });
  await waitFor(() => expect(within(card).getByRole("button", { name: "保存集成设置" })).toBeEnabled());
  return within(card);
}

afterEach(() => vi.restoreAllMocks());

describe("IntegrationSettings", () => {
  it("starts off, requires individual project opt-in, and makes no transport calls", async () => {
    const api = install();
    const fetch = vi.spyOn(window, "fetch");
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    for (const checkbox of card.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(card.getByRole("button", { name: "测试连接（暂不可用）" })).toBeDisabled();
    expect(api.update).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("masks write-only tokens, clears them after saving, and excludes them from previews", async () => {
    const api = install({ keySuffix: "oken" });
    const user = userEvent.setup();
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    const input = card.getByLabelText("令牌");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    expect(document.body.textContent).not.toContain("oken");
    await user.type(input, "private-test-token");
    expect(input).not.toHaveAttribute("value");
    await user.click(card.getByRole("button", { name: "查看将发送的内容" }));
    const preview = screen.getByRole("dialog");
    expect(preview.textContent).not.toContain("private-test-token");
    expect(preview.textContent).not.toContain("private-project");
    expect(preview).toHaveTextContent("当前不会发送数据");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ token: "private-test-token" }));
    expect(document.body.innerHTML).not.toContain("private-test-token");
    expect(card.getByRole("status")).toHaveTextContent("已保存");
  });

  it("retains a token when blank and only clears it explicitly", async () => {
    const api = install({ keySuffix: "oken" });
    const user = userEvent.setup();
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.update).mock.calls[0][0]).not.toHaveProperty("token");
    await user.click(card.getByLabelText("清除已保存令牌"));
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.update).mock.calls[1][0]).toHaveProperty("token", "");
  });

  it("saves endpoint, read/write scopes and only the selected project", async () => {
    const api = install();
    const user = userEvent.setup();
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    await user.type(card.getByLabelText("服务地址"), "https://192.0.2.1/mcp");
    await user.click(card.getByLabelText("启用外部记忆"));
    await user.click(card.getByLabelText("允许读取记忆"));
    await user.click(card.getByLabelText("允许写入记忆"));
    await user.click(card.getByLabelText("第一个项目"));
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({
      id: "memory", enabled: true, endpoint: "https://192.0.2.1/mcp",
      options: { readEnabled: true, writeEnabled: true, projectIds: ["first"], reviewer: "manual", unavailablePolicy: "block" },
    }));
    expect(card.getByLabelText("第二个项目")).not.toBeChecked();
    await user.click(card.getByLabelText("第一个项目"));
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ projectIds: [] }),
    })));
  });

  it("stores reviewer selection and manual fallback without an auto-allow option", async () => {
    const api = install();
    const user = userEvent.setup();
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = within(screen.getByRole("region", { name: "操作审查" }));
    await waitFor(() => expect(card.getByRole("combobox", { name: "审查方式" })).toBeEnabled());
    await user.click(card.getByRole("combobox", { name: "审查方式" }));
    await user.click(screen.getByRole("option", { name: "HTTP 审查服务" }));
    await user.click(card.getByRole("combobox", { name: "审查服务不可用时" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.click(screen.getByRole("option", { name: "请求手动确认" }));
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(expect.objectContaining({
      id: "approval-review", options: expect.objectContaining({ reviewer: "http", unavailablePolicy: "manual" }),
    })));
  });

  it("restores stored scopes and leaves newly added projects unselected", async () => {
    install({ options: { readEnabled: true, writeEnabled: false, projectIds: ["first"], reviewer: "http", unavailablePolicy: "block" } });
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    expect(card.getByLabelText("允许读取记忆")).toBeChecked();
    expect(card.getByLabelText("允许写入记忆")).not.toBeChecked();
    expect(card.getByLabelText("第一个项目")).toBeChecked();
    expect(card.getByLabelText("第二个项目")).not.toBeChecked();
  });

  it("rejects an invalid endpoint and avoids showing raw transport errors", async () => {
    const api = install();
    const user = userEvent.setup();
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    await user.type(card.getByLabelText("服务地址"), "https://192.0.2.1/mcp?token=secret-value");
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    expect(card.getByRole("alert")).not.toHaveTextContent("secret-value");
    expect(api.update).not.toHaveBeenCalled();
    await user.clear(card.getByLabelText("服务地址"));
    vi.mocked(api.update).mockRejectedValueOnce(new Error("sensitive-token"));
    await user.click(card.getByRole("button", { name: "保存集成设置" }));
    await waitFor(() => expect(card.getByRole("alert")).toHaveTextContent("保存集成设置失败"));
    expect(document.body.textContent).not.toContain("sensitive-token");
  });

  it("disables mutations and erases entered tokens when storage is lost", async () => {
    const api = install();
    const user = userEvent.setup();
    const view = render(<IntegrationSettings mutationsAllowed projects={projects} />);
    const card = await memoryCard();
    await user.type(card.getByLabelText("令牌"), "private-test-token");
    view.rerender(<IntegrationSettings mutationsAllowed={false} projects={projects} />);
    expect(card.getByLabelText("令牌")).toHaveValue("");
    expect(card.getByLabelText("启用外部记忆")).toBeDisabled();
    expect(card.getByRole("button", { name: "保存集成设置" })).toBeDisabled();
    expect(api.update).not.toHaveBeenCalled();
  });

  it("does not accept a malformed response carrying a plaintext token", async () => {
    const api = install();
    vi.mocked(api.get).mockResolvedValue({
      id: "memory", enabled: false, endpoint: "", keySuffix: "", updatedAt: 0,
      token: "private-test-token",
    } as IntegrationSettingsView);
    render(<IntegrationSettings mutationsAllowed projects={projects} />);
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(document.body.innerHTML).not.toContain("private-test-token");
  });

  it("does not apply a late settings load after unmounting", async () => {
    const api = install();
    let resolve!: (value: IntegrationSettingsView) => void;
    vi.mocked(api.get).mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<IntegrationSettings mutationsAllowed projects={projects} />);
    view.unmount();
    await act(async () => resolve({ id: "memory", enabled: false, endpoint: "", keySuffix: "", updatedAt: 0 }));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
