import { AlertTriangle, X } from "lucide-react";

import { ApprovalDialog } from "./components/ApprovalDialog";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { ProgressPanel } from "./components/ProgressPanel";
import { QuickChatView } from "./components/QuickChatView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { useZoroStore } from "./state/useZoroStore";

export function App() {
  const store = useZoroStore();
  const approvalEvent = store.activeTask?.events
    .filter((event) => event.type === "approval_requested")
    .at(-1);

  if (store.loading) {
    return (
      <main className="app-loading">
        <span className="brand-mark" aria-hidden="true">
          Z
        </span>
        <strong>ZoroCoding</strong>
      </main>
    );
  }

  return (
    <div className="app-frame">
      <div className="mac-titlebar" aria-hidden="true">
        <span>ZoroCoding</span>
      </div>
      <div className="app-shell">
        <Sidebar
          projects={store.projects}
          tasks={store.tasks}
          activeTaskId={store.activeTask?.task.id ?? null}
          quickChatSessions={store.quickChatSessions}
          activeQuickChatSessionId={store.activeQuickChatSessionId}
          view={store.view}
          newTaskDisabled={!store.storageReady}
          onNewTask={() => store.setNewTaskOpen(true)}
          onSelectTask={(taskId) => void store.selectTask(taskId)}
          onSelectQuickChatSession={(sessionId) =>
            void store.selectQuickChatSession(sessionId)
          }
          onViewChange={store.setView}
        />

        <main className="workbench">
          {store.view === "settings" ? (
            <SettingsView
              projects={store.projects}
              storageReady={store.storageReady}
              onProvidersChanged={() =>
                void store.reloadModelConfiguration()
              }
            />
          ) : store.view === "quick_chat" ? (
            <QuickChatView store={store} />
          ) : (
            <Workbench
              detail={store.activeTask}
              hasProjects={store.projects.length > 0}
              onNewTask={() => store.setNewTaskOpen(true)}
              onPause={() => void store.pause()}
              onResume={() => void store.resume()}
              onRetry={() => void store.retry()}
              onAddMessage={(content) => store.addMessage(content)}
              onCancel={() => void store.cancel()}
              onOpenProgress={() => store.setProgressOpen(true)}
            />
          )}
        </main>

        {store.view === "workbench" ? (
          <ProgressPanel
            detail={store.activeTask}
            drawerOpen={store.progressOpen}
            onClose={() => store.setProgressOpen(false)}
            onResume={() => void store.resume()}
          />
        ) : null}
      </div>

      {store.error !== null ? (
        <div className="error-toast" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{store.error}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭错误"
            onClick={store.dismissError}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {store.newTaskOpen && store.storageReady ? (
        <NewTaskDialog
          projects={store.projects}
          providers={store.providers}
          initialPrompt={store.pendingConversionPrompt ?? ""}
          requireExplicitProjectSelection={
            store.pendingConversionPrompt !== null
          }
          onAuthorizeProject={store.authorizeProject}
          onSubmit={store.createTask}
          onClose={() => {
            store.setNewTaskOpen(false);
            store.clearPendingConversionPrompt();
          }}
          onOpenSettings={() => {
            store.setNewTaskOpen(false);
            store.clearPendingConversionPrompt();
            store.setView("settings");
          }}
        />
      ) : null}

      {!store.storageReady ? (
        <div className="storage-blocker-backdrop" role="presentation">
          <section
            className="storage-blocker"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="storage-blocker-title"
          >
            <AlertTriangle aria-hidden="true" />
            <div>
              <h2 id="storage-blocker-title">移动硬盘已断开</h2>
              <p>请重新连接移动硬盘并重新启动 ZoroCoding</p>
              <small>为保护项目与密钥，应用不会回退到 Mac 内置磁盘。</small>
            </div>
          </section>
        </div>
      ) : null}

      {store.view === "workbench" &&
      store.activeTask?.task.status === "awaiting_approval" &&
      approvalEvent?.type === "approval_requested" ? (
        <ApprovalDialog
          event={approvalEvent}
          project={store.activeTask.project}
          onResolve={(decision) => void store.resolveApproval(decision)}
        />
      ) : null}
    </div>
  );
}
