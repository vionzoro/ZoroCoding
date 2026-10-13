import { describe, expect, it } from "vitest";

import type { TaskEvent, TaskSnapshot } from "../../src/shared/domain";
import {
  InvalidTaskTransitionError,
  reduceTask,
} from "../../src/main/tasks/taskReducer";

function runningTask(): TaskSnapshot {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "优化模型配置页面",
    prompt: "支持新增、编辑和删除模型 API",
    status: "running",
    providerSnapshot: {
      providerId: "kimi",
      name: "KIMI K3",
      kind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      modelId: "kimi-k3",
      contextLength: 1_000_000,
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
      percent: 0,
      elapsedSeconds: 0,
      remainingSeconds: 60,
      estimationState: "ready",
    },
    currentStepId: "step-1",
    activeSince: 500,
    pausedSince: null,
    pauseReason: null,
    createdAt: 100,
    updatedAt: 500,
  };
}

describe("reduceTask", () => {
  it("pauses a running task after an application interruption", () => {
    const event: TaskEvent = {
      id: "event-1",
      taskId: "task-1",
      type: "app_interrupted",
      at: 1_000,
      payload: {},
    };

    const next = reduceTask(runningTask(), event);

    expect(next.status).toBe("paused");
    expect(next.pauseReason).toBe("interrupted");
    expect(next.pausedSince).toBe(1_000);
    expect(next.progress.estimationState).toBe("paused");
  });

  it("enters approval state without losing the current step", () => {
    const event: TaskEvent = {
      id: "event-2",
      taskId: "task-1",
      type: "approval_requested",
      at: 1_200,
      payload: {
        approvalId: "approval-1",
        summary: "删除 build 目录",
        reasons: ["删除操作需要确认"],
      },
    };

    const next = reduceTask(runningTask(), event);

    expect(next.status).toBe("awaiting_approval");
    expect(next.currentStepId).toBe("step-1");
    expect(next.pausedSince).toBe(1_200);
    expect(next.progress.estimationState).toBe("paused");
  });

  it("rejects completion from draft state", () => {
    const task = { ...runningTask(), status: "draft" as const };
    const event: TaskEvent = {
      id: "event-3",
      taskId: "task-1",
      type: "task_completed",
      at: 1_500,
      payload: {},
    };

    expect(() => reduceTask(task, event)).toThrow(InvalidTaskTransitionError);
  });
});


it("records an advisory review while keeping the task running", () => {
  const snapshot = runningTask();
  const event: TaskEvent = { id: "review-1", taskId: snapshot.id, at: 900, type: "approval_reviewed", payload: {
    approvalId: "approval-1", tier: "T2", review: { outcome: "deny", entries: [{ reviewer: "审查", verdict: "deny", text: "风险" }] },
  } };
  expect(reduceTask(snapshot, event)).toEqual({ ...snapshot, updatedAt: 900 });
  expect(() => reduceTask({ ...snapshot, status: "paused" }, event)).toThrow(InvalidTaskTransitionError);
});
