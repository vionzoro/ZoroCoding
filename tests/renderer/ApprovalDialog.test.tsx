// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalDialog } from "../../src/renderer/components/ApprovalDialog";
import type { TaskEvent } from "../../src/shared/domain";

const project = {
  id: "project-1",
  name: "demo",
  canonicalPath: "demo",
  lastOpenedAt: 100,
};
const event: Extract<TaskEvent, { type: "approval_requested" }> = {
  id: "event-1",
  taskId: "task-1",
  type: "approval_requested",
  at: 100,
  payload: {
    approvalId: "approval-1",
    requestDigest: "a".repeat(64),
    summary: "确认运行高风险命令",
    reasons: ["命令会删除文件或目录"],
  },
};

afterEach(cleanup);

describe("ApprovalDialog", () => {
  it.each([
    ["允许一次", "allow_once"],
    ["拒绝", "deny"],
    ["Escape", "deny"],
  ] as const)("binds %s to the displayed request", async (action, decision) => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<ApprovalDialog event={event} project={project} onResolve={onResolve} />);
    if (action === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      await user.click(screen.getByRole("button", { name: action }));
    }
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({
      taskId: event.taskId,
      approvalId: event.payload.approvalId,
      requestDigest: event.payload.requestDigest,
      decision,
    });
  });

  it("keeps legacy requests readable without submitting an unbound response", async () => {
    const { requestDigest: _digest, ...payload } = event.payload;
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(
      <ApprovalDialog event={{ ...event, payload }} project={project} onResolve={onResolve} />,
    );
    expect(screen.getByText(event.payload.summary)).toBeVisible();
    expect(screen.getByText(event.payload.reasons[0])).toBeVisible();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onResolve).not.toHaveBeenCalled();
  });
});
