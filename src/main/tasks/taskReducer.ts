import type {
  TaskEvent,
  TaskSnapshot,
  TaskStatus,
} from "../../shared/domain";

export class InvalidTaskTransitionError extends Error {
  constructor(status: TaskStatus, event: TaskEvent["type"]) {
    super(`Cannot apply ${event} while task is ${status}`);
    this.name = "InvalidTaskTransitionError";
  }
}

function assertStatus(
  snapshot: TaskSnapshot,
  event: TaskEvent["type"],
  allowed: TaskStatus[],
): void {
  if (!allowed.includes(snapshot.status)) {
    throw new InvalidTaskTransitionError(snapshot.status, event);
  }
}

export function reduceTask(
  snapshot: TaskSnapshot,
  event: TaskEvent,
): TaskSnapshot {
  switch (event.type) {
    case "planning_started": {
      assertStatus(snapshot, event.type, ["draft"]);
      return {
        ...snapshot,
        status: "planning",
        activeSince: event.at,
        progress: {
          ...snapshot.progress,
          estimationState: "recalculating",
        },
        updatedAt: event.at,
      };
    }
    case "plan_created": {
      assertStatus(snapshot, event.type, ["planning"]);
      return {
        ...snapshot,
        title: event.payload.title,
        status: "running",
        progress: {
          ...snapshot.progress,
          estimationState: "ready",
        },
        updatedAt: event.at,
      };
    }
    case "step_started": {
      assertStatus(snapshot, event.type, ["running"]);
      return {
        ...snapshot,
        currentStepId: event.payload.stepId,
        updatedAt: event.at,
      };
    }
    case "step_completed": {
      assertStatus(snapshot, event.type, ["running"]);
      return {
        ...snapshot,
        currentStepId: null,
        updatedAt: event.at,
      };
    }
    case "tool_started":
    case "tool_completed":
    case "tool_output": {
      assertStatus(snapshot, event.type, ["running"]);
      return {
        ...snapshot,
        updatedAt: event.at,
      };
    }
    case "memory_context_loaded":
    case "model_output": {
      assertStatus(snapshot, event.type, ["planning", "running"]);
      return {
        ...snapshot,
        updatedAt: event.at,
      };
    }
    case "app_interrupted": {
      assertStatus(snapshot, event.type, [
        "planning",
        "running",
        "awaiting_approval",
      ]);
      return {
        ...snapshot,
        status: "paused",
        pausedSince: event.at,
        pauseReason: "interrupted",
        progress: {
          ...snapshot.progress,
          estimationState: "paused",
        },
        updatedAt: event.at,
      };
    }
    case "approval_requested": {
      assertStatus(snapshot, event.type, ["running"]);
      return {
        ...snapshot,
        status: "awaiting_approval",
        pausedSince: event.at,
        pauseReason: "approval",
        progress: {
          ...snapshot.progress,
          estimationState: "paused",
        },
        updatedAt: event.at,
      };
    }
    case "approval_resolved": {
      assertStatus(snapshot, event.type, ["awaiting_approval"]);
      return {
        ...snapshot,
        status: "running",
        pausedSince: null,
        pauseReason: null,
        progress: {
          ...snapshot.progress,
          estimationState: "ready",
        },
        updatedAt: event.at,
      };
    }
    case "backoff_started": {
      assertStatus(snapshot, event.type, [event.payload.phase]);
      return {
        ...snapshot,
        status: "paused",
        pausedSince: event.at,
        pauseReason: "backoff",
        progress: {
          ...snapshot.progress,
          estimationState: "paused",
        },
        updatedAt: event.at,
      };
    }
    case "backoff_finished": {
      assertStatus(snapshot, event.type, ["paused"]);
      return {
        ...snapshot,
        status: event.payload.phase,
        pausedSince: null,
        pauseReason: null,
        progress: {
          ...snapshot.progress,
          estimationState:
            event.payload.phase === "planning" ? "recalculating" : "ready",
        },
        updatedAt: event.at,
      };
    }
    case "task_paused": {
      assertStatus(snapshot, event.type, [
        "planning",
        "running",
        "awaiting_approval",
        "paused",
      ]);
      return {
        ...snapshot,
        status: "paused",
        pausedSince: event.at,
        pauseReason: "user",
        progress: {
          ...snapshot.progress,
          estimationState: "paused",
        },
        updatedAt: event.at,
      };
    }
    case "task_resumed": {
      assertStatus(snapshot, event.type, ["paused"]);
      return {
        ...snapshot,
        status: event.payload.phase,
        pausedSince: null,
        pauseReason: null,
        progress: {
          ...snapshot.progress,
          estimationState:
            event.payload.phase === "planning" ? "recalculating" : "ready",
        },
        updatedAt: event.at,
      };
    }
    case "task_failed": {
      assertStatus(snapshot, event.type, [
        "draft",
        "planning",
        "running",
        "awaiting_approval",
        "paused",
      ]);
      return {
        ...snapshot,
        status: "failed",
        currentStepId: null,
        activeSince: null,
        pausedSince: null,
        pauseReason: null,
        updatedAt: event.at,
      };
    }
    case "task_retried": {
      assertStatus(snapshot, event.type, ["failed"]);
      return {
        ...snapshot,
        status: event.payload.phase,
        activeSince: snapshot.activeSince ?? event.at,
        pausedSince: null,
        pauseReason: null,
        progress: {
          ...snapshot.progress,
          estimationState:
            event.payload.phase === "planning" ? "recalculating" : "ready",
        },
        updatedAt: event.at,
      };
    }
    case "task_canceled": {
      assertStatus(snapshot, event.type, [
        "draft",
        "planning",
        "running",
        "awaiting_approval",
        "paused",
      ]);
      return {
        ...snapshot,
        status: "canceled",
        currentStepId: null,
        activeSince: null,
        pausedSince: null,
        pauseReason: null,
        updatedAt: event.at,
      };
    }
    case "task_completed": {
      assertStatus(snapshot, event.type, ["running"]);
      return {
        ...snapshot,
        status: "completed",
        currentStepId: null,
        activeSince: null,
        pausedSince: null,
        pauseReason: null,
        progress: {
          ...snapshot.progress,
          percent: 100,
          remainingSeconds: 0,
          estimationState: "ready",
        },
        updatedAt: event.at,
      };
    }
  }
}
