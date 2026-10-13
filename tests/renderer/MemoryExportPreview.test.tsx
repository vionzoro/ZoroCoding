// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { MemoryExportPreview } from "../../src/renderer/components/MemoryExportPreview";
import type { MemoryExportApi, MemoryExportView } from "../../src/shared/memoryExport";

afterEach(cleanup);
function api(): MemoryExportApi {
  let records: MemoryExportView[] = [];
  return {
    destinations: vi.fn(async () => [{ id: "destination-1", label: "目标一" }, { id: "destination-2", label: "目标二" }]),
    preview: vi.fn(async (_taskId, destinationId) => ({ token: "preview-token", destinationId, destinationLabel: destinationId === "destination-1" ? "目标一" : "目标二", entry: { id: "record-1", title: "任务完成记录", content: "任务已完成。完成步骤：1。" } })),
    consent: vi.fn(async () => {
      const record: MemoryExportView = { clientWriteId: "write-1", taskId: "task-1", destinationId: "destination-1", state: "queued" };
      records = [record];
      return record;
    }),
    list: vi.fn(async () => records),
    revoke: vi.fn(async () => { records = []; return true; }),
    flush: vi.fn(async () => { records = records.map((record) => ({ ...record, state: "unknown" })); }),
  };
}
describe("memory export preview", () => {
  it("hides export when no destination is configured", async () => {
    const service = api();
    service.destinations = vi.fn(async () => []);
    const { container } = render(<MemoryExportPreview taskId="task-1" api={service} />);
    await waitFor(() => expect(service.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(service.consent).not.toHaveBeenCalled();
    expect(service.flush).not.toHaveBeenCalled();
  });
  it("shows the exact preview and destination before consent and allows cancellation and revocation", async () => {
    const user = userEvent.setup();
    const service = api();
    render(<MemoryExportPreview taskId="task-1" api={service} />);
    await user.click(await screen.findByRole("button", { name: "预览导出到 目标一" }));
    expect(screen.getByText("目标：目标一")).toBeInTheDocument();
    expect(screen.getByText(/"content": "任务已完成。完成步骤：1。"/)).toBeInTheDocument();
    expect(screen.getByText(/同意后仅保存此预览内容/)).toBeInTheDocument();
    expect(service.consent).not.toHaveBeenCalled();
    expect(service.flush).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消预览" }));
    expect(service.consent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "预览导出到 目标一" }));
    await user.click(screen.getByRole("button", { name: "同意此目标并加入待发送队列" }));
    expect(service.consent).toHaveBeenCalledExactlyOnceWith("preview-token");
    expect(service.flush).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "撤回同意" }));
    expect(service.revoke).toHaveBeenCalledExactlyOnceWith("write-1");
    expect(screen.queryByText(/待发送（可撤回）/)).not.toBeInTheDocument();
  });
  it("displays unknown export separately from completed task, without offering a retry", async () => {
    const user = userEvent.setup();
    const service = api();
    render(<MemoryExportPreview taskId="task-1" api={service} />);
    await user.click(await screen.findByRole("button", { name: "预览导出到 目标一" }));
    await user.click(screen.getByRole("button", { name: "同意此目标并加入待发送队列" }));
    await user.click(await screen.findByRole("button", { name: "发送此任务已同意的记录" }));
    expect(await screen.findByText(/接收状态未知，不会自动重试/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤回同意" })).not.toBeInTheDocument();
    expect(service.flush).toHaveBeenCalledTimes(1);
  });
});
