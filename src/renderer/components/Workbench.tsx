import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  FileText,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Send,
  Square,
  Terminal,
} from "lucide-react";

import type { TaskStatus } from "../../shared/domain";
import type { TaskDetail } from "../../shared/ipc";
import type { TaskIntent } from "../../shared/taskRouting";
import { MemoryExportPreview } from "./MemoryExportPreview";
import { CodePatch } from "./CodePatch";
import { EmptyState } from "./EmptyState";
import {
  collectLiveTerminalOutput,
  TerminalOutput,
} from "./TerminalOutput";

const INTENT_LABELS: Record<TaskIntent, string> = {
  simple_qa: "简单问答",
  simple_text: "文字处理",
  simple_code: "代码解释",
  complex_code: "复杂代码",
  media_script: "绘图 / 视频脚本",
};

function executionModeCopy(mode: "read_only" | "agentic"): string {
  return mode === "read_only" ? "只读问答" : "完整执行";
}

function statusCopy(status: TaskStatus): string {
  switch (status) {
    case "draft":
      return "准备中";
    case "planning":
      return "正在规划";
    case "running":
      return "执行中";
    case "awaiting_approval":
      return "等待批准";
    case "paused":
      return "已暂停";
    case "completed":
      return "任务已完成";
    case "failed":
      return "执行失败";
    case "canceled":
      return "已取消";
  }
}

function ActivityIcon({
  kind,
}: {
  kind: "message" | "file" | "terminal";
}) {
  if (kind === "file") {
    return <Code2 aria-hidden="true" />;
  }
  if (kind === "terminal") {
    return <Terminal aria-hidden="true" />;
  }
  return <FileText aria-hidden="true" />;
}

interface WorkbenchProps {
  detail: TaskDetail | null;
  hasProjects: boolean;
  onNewTask(): void;
  onPause(): void;
  onResume(): void;
  onRetry(): void;
  onAddMessage(content: string): Promise<void>;
  onCancel(): void;
  onOpenProgress(): void;
}

export function Workbench({
  detail,
  hasProjects,
  onNewTask,
  onPause,
  onResume,
  onRetry,
  onAddMessage,
  onCancel,
  onOpenProgress,
}: WorkbenchProps) {
  const [followup, setFollowup] = useState("");
  if (detail === null) {
    return <EmptyState hasProjects={hasProjects} onNewTask={onNewTask} />;
  }

  const { task, project, messages, fileChanges, events } = detail;
  const isActive = ["planning", "running", "awaiting_approval"].includes(
    task.status,
  );
  const terminalEvents = events.filter(
    (event) =>
      event.type === "tool_completed" &&
      event.payload.name === "run_shell" &&
      !event.payload.denied,
  );
  const failedEvent = [...events]
    .reverse()
    .find((event) => event.type === "task_failed");
  const lastBoundaryIndex = events.findLastIndex(
    (event) => event.type !== "model_output",
  );
  const liveModelText =
    task.status === "running"
      ? events
          .slice(lastBoundaryIndex + 1)
          .filter((event) => event.type === "model_output")
          .map((event) =>
            event.type === "model_output" ? event.payload.text : "",
          )
          .join("")
      : "";
  const liveTerminal = collectLiveTerminalOutput(events);
  const canAddMessage = [
    "planning",
    "running",
    "awaiting_approval",
    "paused",
    "failed",
  ].includes(task.status);

  return (
    <div className="workbench-inner">
      <header className="task-header">
        <div className="task-heading">
          <span className="task-context">
            {project.name} · main
          </span>
          <h1>{task.title}</h1>
          <span className={`status-text status-${task.status}`} aria-live="polite">
            {task.status === "completed" ? (
              <CheckCircle2 aria-hidden="true" />
            ) : task.status === "failed" ? (
              <AlertTriangle aria-hidden="true" />
            ) : task.status === "running" || task.status === "planning" ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <PauseCircle aria-hidden="true" />
            )}
            {statusCopy(task.status)} · {task.providerSnapshot.name}
          </span>
          <div className="task-routing-summary" aria-label="任务路由记录">
            <span>已识别：{INTENT_LABELS[task.routeDecision.intent]}</span>
            <span>选择方式：{task.selectionMode === "auto" ? "自动" : "手动"}</span>
            <span>
              实际模型：{task.providerSnapshot.name} · {task.providerSnapshot.modelId}
            </span>
            <span>执行方式：{executionModeCopy(task.executionMode)}</span>
          </div>
        </div>
        <div className="task-actions">
          <button
            className="progress-drawer-button"
            type="button"
            onClick={onOpenProgress}
          >
            查看任务进度
          </button>
          {isActive ? (
            <button className="secondary-button" type="button" onClick={onPause}>
              <PauseCircle aria-hidden="true" />
              暂停
            </button>
          ) : task.status === "paused" ? (
            <button className="primary-button compact" type="button" onClick={onResume}>
              <PlayCircle aria-hidden="true" />
              {task.pauseReason === "interrupted" ? "安全继续" : "继续"}
            </button>
          ) : null}
          {!["completed", "failed", "canceled"].includes(task.status) ? (
            <button
              className="icon-button"
              type="button"
              aria-label="取消任务"
              onClick={() => {
                if (
                  window.confirm(
                    "确定取消这个任务吗？已产生的文件修改和执行记录会保留。",
                  )
                ) {
                  onCancel();
                }
              }}
            >
              <Square aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {task.pauseReason === "interrupted" ? (
        <div className="recovery-banner" role="status">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>上次执行被中断</strong>
            <span>已停在安全状态，不会自动重复已完成的操作。</span>
          </div>
          <button className="primary-button compact" type="button" onClick={onResume}>
            安全继续
          </button>
        </div>
      ) : null}

      {failedEvent?.type === "task_failed" ? (
        <div className="recovery-banner failure-banner" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>任务执行失败</strong>
            <span>{failedEvent.payload.message}</span>
          </div>
          <button
            className="primary-button compact"
            type="button"
            onClick={onRetry}
          >
            重试失败步骤
          </button>
        </div>
      ) : null}

      <section className="activity-feed" aria-label="任务执行记录">
        {messages.map((message) =>
          message.role === "user" ? (
            <article className="user-message" key={message.id}>
              <span>你</span>
              <p>{message.content}</p>
            </article>
          ) : message.role === "assistant" && message.content ? (
            <article className="activity-row" key={message.id}>
              <span className="activity-icon completed">
                <ActivityIcon kind="message" />
              </span>
              <div>
                <strong>ZoroCoding</strong>
                <p>{message.content}</p>
              </div>
            </article>
          ) : null,
        )}

        {liveModelText.length > 0 ? (
          <article className="activity-row" aria-live="polite">
            <span className="activity-icon running">
              <LoaderCircle className="spin" aria-hidden="true" />
            </span>
            <div>
              <strong>ZoroCoding 正在输出</strong>
              <p>{liveModelText}</p>
            </div>
          </article>
        ) : null}

        {fileChanges.map((change) => (
          <details className="activity-details" key={change.id}>
            <summary>
              <span className="activity-icon completed">
                <ActivityIcon kind="file" />
              </span>
              <span>
                <strong>已修改文件</strong>
                <small>{change.canonicalPath}</small>
              </span>
            </summary>
            <CodePatch patch={change.patch} />
          </details>
        ))}

        {terminalEvents.map((event) =>
          event.type === "tool_completed" ? (
            <details className="activity-details" key={event.id}>
              <summary>
                <span className="activity-icon completed">
                  <ActivityIcon kind="terminal" />
                </span>
                <span>
                  <strong>终端输出</strong>
                  <small>{event.payload.ok ? "命令执行完成" : "命令返回错误"}</small>
                </span>
              </summary>
              <TerminalOutput
                text={event.payload.content}
                status={event.payload.ok ? "normal" : "error"}
                label={
                  event.payload.ok
                    ? "命令执行完成"
                    : "命令返回错误"
                }
              />
            </details>
          ) : null,
        )}

        {liveTerminal.active ? (
          <details className="activity-details" open>
            <summary>
              <span className="activity-icon running">
                <ActivityIcon kind="terminal" />
              </span>
              <span>
                <strong>终端正在运行</strong>
                <small>实时输出</small>
              </span>
            </summary>
            <TerminalOutput
              text={liveTerminal.text || "等待命令输出…"}
              status="waiting"
              label="实时输出"
            />
          </details>
        ) : null}
        {task.status === "completed" ? (
          <MemoryExportPreview key={task.id} taskId={task.id} api={window.zoro?.memoryExports} />
        ) : null}
      </section>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = followup.trim();
          if (content.length === 0 || !canAddMessage) {
            return;
          }
          void onAddMessage(content).then(() => setFollowup(""));
        }}
      >
        <textarea
          rows={2}
          aria-label="继续输入要求"
          placeholder={
            canAddMessage
              ? "继续输入补充要求…"
              : "任务已结束；可发起新任务继续"
          }
          value={followup}
          disabled={!canAddMessage}
          onChange={(event) => setFollowup(event.target.value)}
        />
        <button
          className="send-button"
          type="submit"
          aria-label="发送补充要求"
          disabled={!canAddMessage || followup.trim().length === 0}
        >
          <Send aria-hidden="true" />
          <span>发送</span>
        </button>
      </form>
    </div>
  );
}
