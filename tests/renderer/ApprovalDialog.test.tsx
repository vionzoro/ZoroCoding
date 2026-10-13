// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalDialog } from "../../src/renderer/components/ApprovalDialog";
import type { TaskEvent } from "../../src/shared/domain";

const event: Extract<TaskEvent, { type: "approval_requested" }> = {
  id: "event-1", taskId: "task-1", at: 100, type: "approval_requested",
  payload: {
    approvalId: "approval-1", summary: "确认读取", reasons: ["项目外读取"], tier: "T2",
    review: { outcome: "ask_human", entries: [
      { reviewer: "策略审查", verdict: "request_information", text: "请核对文件用途" },
    ] },
  },
};
const project = { id: "project-1", name: "示例项目", canonicalPath: "project", lastOpenedAt: 100 };

describe("ApprovalDialog", () => {
  it("shows review text in a separate section without changing permission reasons", () => {
    const onResolve = vi.fn();
    const rendered = render(<ApprovalDialog event={event} project={project} onResolve={onResolve} />);
    const review = screen.getByRole("region", { name: "独立审查" });
    expect(within(review).getByText("请核对文件用途", { exact: false })).toBeInTheDocument();
    expect(within(review).queryByText("项目外读取")).not.toBeInTheDocument();
    expect(screen.getByText("项目外读取").closest("section")).not.toBe(review);
    expect(screen.getByText("风险级别：T2")).toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onResolve).toHaveBeenCalledWith("deny");
    rendered.unmount();
  });

  it("renders older approval events without a review section", () => {
    const rendered = render(<ApprovalDialog event={{ ...event, payload: {
      approvalId: "approval-1", summary: "确认读取", reasons: ["项目外读取"],
    } }} project={project} onResolve={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "独立审查" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeInTheDocument();
    rendered.unmount();
  });
});
