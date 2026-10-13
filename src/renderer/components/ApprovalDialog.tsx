import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect } from "react";

import type { ApprovalRequest } from "../../shared/ipc";
import type { ProjectSummary, TaskEvent } from "../../shared/domain";

interface ApprovalDialogProps {
  event: Extract<TaskEvent, { type: "approval_requested" }>;
  project: ProjectSummary;
  onResolve(request: ApprovalRequest): void;
}

export function ApprovalDialog({
  event,
  project,
  onResolve,
}: ApprovalDialogProps) {
  const requestDigest = event.payload.requestDigest;
  const resolve = useCallback((decision: "allow_once" | "deny") => {
    if (requestDigest === undefined) return;
    onResolve({
      taskId: event.taskId,
      approvalId: event.payload.approvalId,
      requestDigest,
      decision,
    });
  }, [event.taskId, event.payload.approvalId, requestDigest, onResolve]);

  useEffect(() => {
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        resolve("deny");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resolve]);

  return (
    <div className="modal-backdrop approval-backdrop" role="presentation">
      <section
        className="modal approval-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
      >
        <span className="approval-icon" aria-hidden="true">
          <AlertTriangle />
        </span>
        <div>
          <span className="modal-kicker">需要你的批准</span>
          <h2 id="approval-title">{event.payload.summary}</h2>
          <p id="approval-description">
            此操作超出普通项目内开发操作的自动授权范围。
          </p>
        </div>
        <ul className="approval-reasons">
          {event.payload.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <div className="project-boundary">
          <span>当前项目边界</span>
          <code>{project.canonicalPath}</code>
        </div>
        <p className="approval-hint">
          {requestDigest === undefined
            ? "此批准请求已过期，请暂停后恢复任务以重新确认。"
            : "按 Esc 将拒绝此操作。"}
        </p>
        <footer className="modal-actions">
          <button
            className="danger-button"
            type="button"
            disabled={requestDigest === undefined}
            onClick={() => resolve("deny")}
          >
            拒绝
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={requestDigest === undefined}
            onClick={() => resolve("allow_once")}
          >
            允许一次
          </button>
        </footer>
      </section>
    </div>
  );
}
