import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";

import type { ProjectSummary, TaskEvent } from "../../shared/domain";

interface ApprovalDialogProps {
  event: Extract<TaskEvent, { type: "approval_requested" }>;
  project: ProjectSummary;
  onResolve(decision: "allow_once" | "deny"): void;
}

export function ApprovalDialog({
  event,
  project,
  onResolve,
}: ApprovalDialogProps) {
  useEffect(() => {
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        onResolve("deny");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onResolve]);

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
        {event.payload.tier !== undefined ? (
          <p className="approval-hint">风险级别：{event.payload.tier}</p>
        ) : null}
        {event.payload.review !== undefined ? (
          <section aria-label="独立审查">
            <h3>独立审查</h3>
            <ul className="approval-reasons">
              {event.payload.review.entries.map((entry, index) => (
                <li key={index}>
                  <strong>{entry.reviewer}</strong>：{entry.text}
                </li>
              ))}
            </ul>
            <p className="approval-hint">审查意见仅供参考，仍需你批准。</p>
          </section>
        ) : null}
        <div className="project-boundary">
          <span>当前项目边界</span>
          <code>{project.canonicalPath}</code>
        </div>
        <p className="approval-hint">按 Esc 将拒绝此操作。</p>
        <footer className="modal-actions">
          <button
            className="danger-button"
            type="button"
            onClick={() => onResolve("deny")}
          >
            拒绝
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => onResolve("allow_once")}
          >
            允许一次
          </button>
        </footer>
      </section>
    </div>
  );
}
