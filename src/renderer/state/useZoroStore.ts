import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ApprovalRequest,
  CreateTaskRequest,
  ProviderSummary,
  ResolvedRouteView,
  RoutingConfigView,
  TaskDetail,
  TaskSummary,
} from "../../shared/ipc";
import type {
  ProjectSummary,
  QuickChatMessage,
  QuickChatSession,
} from "../../shared/domain";
import type { ModelSelection } from "../../shared/taskRouting";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

export type AppView = "workbench" | "quick_chat" | "settings";

export interface ZoroStore {
  loading: boolean;
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  providers: ProviderSummary[];
  routingConfig: RoutingConfigView | null;
  activeTask: TaskDetail | null;
  quickChatSessions: QuickChatSession[];
  activeQuickChatSessionId: string | null;
  quickChatMessages: QuickChatMessage[];
  quickChatStreamingText: Record<string, string>;
  quickChatPrompt: string;
  quickChatSelection: ModelSelection;
  quickChatRoutePreview: ResolvedRouteView | null;
  quickChatPreviewing: boolean;
  quickChatPreviewError: string | null;
  quickChatSending: boolean;
  pendingConversionPrompt: string | null;
  storageReady: boolean;
  error: string | null;
  view: AppView;
  newTaskOpen: boolean;
  progressOpen: boolean;
  setView(view: AppView): void;
  setNewTaskOpen(open: boolean): void;
  setProgressOpen(open: boolean): void;
  dismissError(): void;
  authorizeProject(): Promise<ProjectSummary | null>;
  createTask(input: CreateTaskRequest): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  retry(): Promise<void>;
  addMessage(content: string): Promise<void>;
  cancel(): Promise<void>;
  resolveApproval(request: ApprovalRequest): Promise<void>;
  reloadProviders(): Promise<void>;
  reloadModelConfiguration(): Promise<void>;
  createQuickChatSession(): Promise<void>;
  selectQuickChatSession(sessionId: string): Promise<void>;
  renameQuickChatSession(sessionId: string, title: string): Promise<void>;
  deleteQuickChatSession(sessionId: string): Promise<void>;
  setQuickChatPrompt(prompt: string): void;
  setQuickChatSelection(selection: ModelSelection): void;
  previewQuickChatRoute(
    prompt: string,
    selection: ModelSelection,
  ): Promise<void>;
  sendQuickChat(): Promise<void>;
  cancelQuickChat(): Promise<void>;
  retryQuickChat(messageId: string): Promise<void>;
  convertQuickChatToProject(prompt: string): void;
  clearPendingConversionPrompt(): void;
}

export function useZoroStore(): ZoroStore {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [routingConfig, setRoutingConfig] =
    useState<RoutingConfigView | null>(null);
  const [activeTask, setActiveTask] = useState<TaskDetail | null>(null);
  const [quickChatSessions, setQuickChatSessions] = useState<
    QuickChatSession[]
  >([]);
  const [activeQuickChatSessionId, setActiveQuickChatSessionId] = useState<
    string | null
  >(null);
  const [quickChatMessages, setQuickChatMessages] = useState<
    QuickChatMessage[]
  >([]);
  const [quickChatStreamingText, setQuickChatStreamingText] = useState<
    Record<string, string>
  >({});
  const [quickChatPrompt, setQuickChatPrompt] = useState("");
  const [quickChatSelection, setQuickChatSelection] =
    useState<ModelSelection>({ mode: "auto" });
  const [quickChatRoutePreview, setQuickChatRoutePreview] =
    useState<ResolvedRouteView | null>(null);
  const [quickChatPreviewing, setQuickChatPreviewing] = useState(false);
  const [quickChatPreviewError, setQuickChatPreviewError] = useState<
    string | null
  >(null);
  const [quickChatSending, setQuickChatSending] = useState(false);
  const [pendingConversionPrompt, setPendingConversionPrompt] = useState<
    string | null
  >(null);
  const [storageAvailable, setStorageAvailable] = useState(false);
  const [restartRequired, setRestartRequired] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("workbench");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const activeTaskId = useRef<string | null>(null);
  const activeQuickChatSessionIdRef = useRef<string | null>(null);
  const quickChatSessionsRef = useRef<QuickChatSession[]>([]);
  const quickChatPreviewRequest = useRef(0);
  const quickChatLocalMessage = useRef(0);
  const quickChatSelectionRef = useRef<ModelSelection>({ mode: "auto" });
  const storageStatusSeen = useRef(false);
  const storageReady = storageAvailable && !restartRequired;

  const fail = useCallback((caught: unknown) => {
    setError(messageFor(caught));
  }, []);

  const changeQuickChatSelection = useCallback(
    (selection: ModelSelection) => {
      quickChatPreviewRequest.current += 1;
      quickChatSelectionRef.current = selection;
      setQuickChatSelection(selection);
      setQuickChatRoutePreview(null);
      setQuickChatPreviewError(null);
      setQuickChatPreviewing(false);
    },
    [],
  );

  const applyProviderList = useCallback(
    (loadedProviders: ProviderSummary[]) => {
      setProviders(loadedProviders);
      const selection = quickChatSelectionRef.current;
      if (
        selection.mode === "manual" &&
        !loadedProviders.some(
          (provider) => provider.id === selection.providerId,
        )
      ) {
        changeQuickChatSelection({ mode: "auto" });
      }
    },
    [changeQuickChatSelection],
  );

  const loadTask = useCallback(
    async (taskId: string) => {
      try {
        const detail = await window.zoro.tasks.get(taskId);
        activeTaskId.current = taskId;
        setActiveTask(detail);
      } catch (caught) {
        fail(caught);
      }
    },
    [fail],
  );

  const reloadProviders = useCallback(async () => {
    try {
      applyProviderList(await window.zoro.providers.list());
    } catch (caught) {
      fail(caught);
    }
  }, [applyProviderList, fail]);

  const reloadModelConfiguration = useCallback(async () => {
    try {
      const [loadedProviders, loadedRoutingConfig] = await Promise.all([
        window.zoro.providers.list(),
        window.zoro.routing.get(),
      ]);
      applyProviderList(loadedProviders);
      setRoutingConfig(loadedRoutingConfig);
    } catch (caught) {
      fail(caught);
    }
  }, [applyProviderList, fail]);

  const loadQuickChatMessages = useCallback(
    async (sessionId: string) => {
      try {
        const messages = await window.zoro.quickChat.listMessages(sessionId);
        if (activeQuickChatSessionIdRef.current !== sessionId) {
          return;
        }
        setQuickChatMessages(messages);
        setQuickChatStreamingText({});
        setQuickChatSending(
          messages.some(
            (message) =>
              message.role === "assistant" && message.status === "streaming",
          ),
        );
      } catch (caught) {
        fail(caught);
      }
    },
    [fail],
  );

  useEffect(() => {
    let disposed = false;
    const initialize = async () => {
      try {
        const [
          loadedAppInfo,
          loadedProjects,
          loadedTasks,
          loadedProviders,
          loadedRoutingConfig,
          loadedQuickChatSessions,
        ] =
          await Promise.all([
            window.zoro.app.info(),
            window.zoro.projects.list(),
            window.zoro.tasks.list(),
            window.zoro.providers.list(),
            window.zoro.routing.get(),
            window.zoro.quickChat.listSessions(),
          ]);
        if (disposed) {
          return;
        }
        if (!storageStatusSeen.current) {
          setStorageAvailable(loadedAppInfo.storageAvailable);
          setRestartRequired(loadedAppInfo.restartRequired);
        }
        setProjects(loadedProjects);
        setTasks(loadedTasks);
        setProviders(loadedProviders);
        setRoutingConfig(loadedRoutingConfig);
        quickChatSessionsRef.current = loadedQuickChatSessions;
        setQuickChatSessions(loadedQuickChatSessions);
        const firstQuickChatSession = loadedQuickChatSessions[0];
        if (firstQuickChatSession !== undefined) {
          activeQuickChatSessionIdRef.current = firstQuickChatSession.id;
          setActiveQuickChatSessionId(firstQuickChatSession.id);
          const messages = await window.zoro.quickChat.listMessages(
            firstQuickChatSession.id,
          );
          if (!disposed) {
            setQuickChatMessages(messages);
            setQuickChatSending(
              messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.status === "streaming",
              ),
            );
          }
        }
        if (loadedTasks[0] !== undefined) {
          const detail = await window.zoro.tasks.get(loadedTasks[0].id);
          if (!disposed) {
            activeTaskId.current = detail.task.id;
            setActiveTask(detail);
          }
        }
      } catch (caught) {
        if (!disposed) {
          fail(caught);
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };
    void initialize();

    const unsubscribeStorage = window.zoro.app.subscribeStorageStatus(
      (status) => {
        if (disposed) {
          return;
        }
        storageStatusSeen.current = true;
        setStorageAvailable(status.storageAvailable);
        setRestartRequired(status.restartRequired);
        setNewTaskOpen(false);
        setQuickChatSending(false);
        setQuickChatStreamingText({});
      },
    );

    const unsubscribe = window.zoro.tasks.subscribe((envelope) => {
      if (disposed) {
        return;
      }
      setTasks((current) => {
        const withoutUpdated = current.filter(
          (task) => task.id !== envelope.task.id,
        );
        return [envelope.task, ...withoutUpdated];
      });
      if (activeTaskId.current === envelope.task.id) {
        if (
          envelope.event?.type === "model_output" ||
          envelope.event?.type === "tool_output"
        ) {
          setActiveTask((current) =>
            current?.task.id === envelope.task.id
              ? {
                  ...current,
                  task: envelope.task,
                  events: [...current.events, envelope.event!],
                }
              : current,
          );
        } else if (envelope.event === undefined) {
          setActiveTask((current) =>
            current?.task.id === envelope.task.id
              ? { ...current, task: envelope.task }
              : current,
          );
        } else {
          void loadTask(envelope.task.id);
        }
      }
    });

    const unsubscribeQuickChat = window.zoro.quickChat.subscribe(
      ({ event }) => {
        if (disposed) {
          return;
        }
        if (event.type === "session_updated") {
          setQuickChatSessions((current) => {
            const updated = [
              event.session,
              ...current.filter(
                (session) => session.id !== event.session.id,
              ),
            ];
            quickChatSessionsRef.current = updated;
            return updated;
          });
          return;
        }
        const sessionId =
          event.type === "message_delta"
            ? event.sessionId
            : event.message.sessionId;
        if (sessionId !== activeQuickChatSessionIdRef.current) {
          return;
        }
        if (event.type === "message_started") {
          setQuickChatSending(true);
          setQuickChatMessages((current) => [
            ...current.filter(
              (message) => message.id !== event.message.id,
            ),
            event.message,
          ]);
          return;
        }
        if (event.type === "message_delta") {
          setQuickChatStreamingText((current) => ({
            ...current,
            [event.messageId]:
              (current[event.messageId] ?? "") + event.text,
          }));
          return;
        }
        setQuickChatMessages((current) => [
          ...current.filter((message) => message.id !== event.message.id),
          event.message,
        ]);
        setQuickChatStreamingText((current) => {
          const next = { ...current };
          delete next[event.message.id];
          return next;
        });
        setQuickChatSending(false);
      },
    );

    return () => {
      disposed = true;
      unsubscribeStorage();
      unsubscribe();
      unsubscribeQuickChat();
    };
  }, [fail, loadTask]);

  const authorizeProject = useCallback(async () => {
    if (!storageReady) {
      return null;
    }
    try {
      const project = await window.zoro.projects.select();
      if (project !== null) {
        setProjects((current) => [
          project,
          ...current.filter((item) => item.id !== project.id),
        ]);
      }
      return project;
    } catch (caught) {
      fail(caught);
      return null;
    }
  }, [fail, storageReady]);

  const createTask = useCallback(
    async (input: CreateTaskRequest) => {
      if (!storageReady) {
        setNewTaskOpen(false);
        return;
      }
      try {
        const detail = await window.zoro.tasks.create(input);
        activeTaskId.current = detail.task.id;
        setActiveTask(detail);
        setTasks((current) => [
          detail.task,
          ...current.filter((task) => task.id !== detail.task.id),
        ]);
        setNewTaskOpen(false);
        setPendingConversionPrompt(null);
        setView("workbench");
      } catch (caught) {
        fail(caught);
      }
    },
    [fail, storageReady],
  );

  const changeNewTaskOpen = useCallback(
    (open: boolean) => {
      setNewTaskOpen(open && storageReady);
    },
    [storageReady],
  );

  const createQuickChatSession = useCallback(async () => {
    if (!storageReady) {
      return;
    }
    try {
      const session = await window.zoro.quickChat.createSession();
      const updated = [
        session,
        ...quickChatSessionsRef.current.filter(
          (item) => item.id !== session.id,
        ),
      ];
      quickChatSessionsRef.current = updated;
      setQuickChatSessions(updated);
      activeQuickChatSessionIdRef.current = session.id;
      setActiveQuickChatSessionId(session.id);
      setQuickChatMessages([]);
      setQuickChatStreamingText({});
      setQuickChatSending(false);
    } catch (caught) {
      fail(caught);
    }
  }, [fail, storageReady]);

  const selectQuickChatSession = useCallback(
    async (sessionId: string) => {
      activeQuickChatSessionIdRef.current = sessionId;
      setActiveQuickChatSessionId(sessionId);
      setQuickChatMessages([]);
      setQuickChatStreamingText({});
      setQuickChatSending(false);
      await loadQuickChatMessages(sessionId);
    },
    [loadQuickChatMessages],
  );

  const changeView = useCallback(
    (nextView: AppView) => {
      setView(nextView);
      if (
        nextView === "quick_chat" &&
        activeQuickChatSessionIdRef.current === null
      ) {
        const existing = quickChatSessionsRef.current[0];
        if (existing === undefined) {
          void createQuickChatSession();
        } else {
          void selectQuickChatSession(existing.id);
        }
      }
    },
    [createQuickChatSession, selectQuickChatSession],
  );

  const renameQuickChatSession = useCallback(
    async (sessionId: string, title: string) => {
      const normalized = title.trim();
      if (!storageReady || normalized.length === 0) {
        return;
      }
      try {
        const session = await window.zoro.quickChat.renameSession(
          sessionId,
          normalized,
        );
        const updated = [
          session,
          ...quickChatSessionsRef.current.filter(
            (item) => item.id !== session.id,
          ),
        ];
        quickChatSessionsRef.current = updated;
        setQuickChatSessions(updated);
      } catch (caught) {
        fail(caught);
      }
    },
    [fail, storageReady],
  );

  const deleteQuickChatSession = useCallback(
    async (sessionId: string) => {
      if (!storageReady) {
        return;
      }
      try {
        await window.zoro.quickChat.deleteSession(sessionId);
        const remaining = quickChatSessionsRef.current.filter(
          (session) => session.id !== sessionId,
        );
        quickChatSessionsRef.current = remaining;
        setQuickChatSessions(remaining);
        if (activeQuickChatSessionIdRef.current !== sessionId) {
          return;
        }
        const next = remaining[0];
        if (next === undefined) {
          activeQuickChatSessionIdRef.current = null;
          setActiveQuickChatSessionId(null);
          setQuickChatMessages([]);
          await createQuickChatSession();
        } else {
          await selectQuickChatSession(next.id);
        }
      } catch (caught) {
        fail(caught);
      }
    },
    [
      createQuickChatSession,
      fail,
      selectQuickChatSession,
      storageReady,
    ],
  );

  const previewQuickChatRoute = useCallback(
    async (prompt: string, selection: ModelSelection) => {
      const requestId = ++quickChatPreviewRequest.current;
      const normalized = prompt.trim();
      setQuickChatRoutePreview(null);
      setQuickChatPreviewError(null);
      if (
        normalized.length === 0 ||
        (selection.mode === "manual" &&
          selection.providerId.length === 0)
      ) {
        setQuickChatPreviewing(false);
        return;
      }
      setQuickChatPreviewing(true);
      try {
        const preview = await window.zoro.routing.preview({
          prompt: normalized,
          selection,
        });
        if (quickChatPreviewRequest.current === requestId) {
          setQuickChatRoutePreview(preview);
        }
      } catch {
        if (quickChatPreviewRequest.current === requestId) {
          setQuickChatPreviewError(
            "无法预览模型路由，请检查设置后重试。",
          );
        }
      } finally {
        if (quickChatPreviewRequest.current === requestId) {
          setQuickChatPreviewing(false);
        }
      }
    },
    [],
  );

  const sendQuickChat = useCallback(async () => {
    const sessionId = activeQuickChatSessionIdRef.current;
    const prompt = quickChatPrompt.trim();
    if (!storageReady || sessionId === null || prompt.length === 0) {
      return;
    }
    const optimistic: QuickChatMessage = {
      id: `local-${Date.now()}-${++quickChatLocalMessage.current}`,
      sessionId,
      role: "user",
      content: prompt,
      providerSnapshot: null,
      routeDecision: null,
      status: "completed",
      errorMessage: null,
      createdAt: Date.now(),
    };
    setQuickChatMessages((current) => [...current, optimistic]);
    setQuickChatPrompt("");
    setQuickChatRoutePreview(null);
    setQuickChatSending(true);
    try {
      const assistant = await window.zoro.quickChat.send({
        sessionId,
        prompt,
        selection: quickChatSelection,
      });
      if (activeQuickChatSessionIdRef.current === sessionId) {
        setQuickChatMessages((current) => [
          ...current.filter((message) => message.id !== assistant.id),
          assistant,
        ]);
      }
    } catch (caught) {
      fail(caught);
    } finally {
      if (activeQuickChatSessionIdRef.current === sessionId) {
        setQuickChatSending(false);
      }
    }
  }, [fail, quickChatPrompt, quickChatSelection, storageReady]);

  const cancelQuickChat = useCallback(async () => {
    const sessionId = activeQuickChatSessionIdRef.current;
    if (sessionId === null) {
      return;
    }
    try {
      await window.zoro.quickChat.cancel(sessionId);
      setQuickChatSending(false);
      setQuickChatStreamingText({});
    } catch (caught) {
      fail(caught);
    }
  }, [fail]);

  const retryQuickChat = useCallback(
    async (messageId: string) => {
      const sessionId = activeQuickChatSessionIdRef.current;
      if (!storageReady || sessionId === null) {
        return;
      }
      setQuickChatSending(true);
      try {
        const assistant = await window.zoro.quickChat.retry({
          sessionId,
          messageId,
          selection: quickChatSelection,
        });
        if (activeQuickChatSessionIdRef.current === sessionId) {
          setQuickChatMessages((current) => [
            ...current.filter(
              (message) => message.id !== assistant.id,
            ),
            assistant,
          ]);
        }
      } catch (caught) {
        fail(caught);
      } finally {
        if (activeQuickChatSessionIdRef.current === sessionId) {
          setQuickChatSending(false);
        }
      }
    },
    [fail, quickChatSelection, storageReady],
  );

  const changeQuickChatPrompt = useCallback((prompt: string) => {
    quickChatPreviewRequest.current += 1;
    setQuickChatPrompt(prompt);
    setQuickChatRoutePreview(null);
    setQuickChatPreviewError(null);
    setQuickChatPreviewing(false);
  }, []);

  const command = useCallback(
    async (action: (taskId: string) => Promise<void>) => {
      const taskId = activeTaskId.current;
      if (taskId === null) {
        return;
      }
      try {
        await action(taskId);
      } catch (caught) {
        fail(caught);
      }
    },
    [fail],
  );

  return {
    loading,
    projects,
    tasks,
    providers,
    routingConfig,
    activeTask,
    quickChatSessions,
    activeQuickChatSessionId,
    quickChatMessages,
    quickChatStreamingText,
    quickChatPrompt,
    quickChatSelection,
    quickChatRoutePreview,
    quickChatPreviewing,
    quickChatPreviewError,
    quickChatSending,
    pendingConversionPrompt,
    storageReady,
    error,
    view,
    newTaskOpen,
    progressOpen,
    setView: changeView,
    setNewTaskOpen: changeNewTaskOpen,
    setProgressOpen,
    dismissError: () => setError(null),
    authorizeProject,
    createTask,
    selectTask: loadTask,
    pause: () => command(window.zoro.tasks.pause),
    resume: () => command(window.zoro.tasks.resume),
    retry: () => command(window.zoro.tasks.retry),
    addMessage: (content) =>
      command((taskId) => window.zoro.tasks.addMessage(taskId, content)),
    cancel: () => command(window.zoro.tasks.cancel),
    resolveApproval: async (request) => {
      try {
        await window.zoro.tasks.resolveApproval(request);
      } catch (caught) {
        fail(caught);
      }
    },
    reloadProviders,
    reloadModelConfiguration,
    createQuickChatSession,
    selectQuickChatSession,
    renameQuickChatSession,
    deleteQuickChatSession,
    setQuickChatPrompt: changeQuickChatPrompt,
    setQuickChatSelection: changeQuickChatSelection,
    previewQuickChatRoute,
    sendQuickChat,
    cancelQuickChat,
    retryQuickChat,
    convertQuickChatToProject: (prompt) => {
      if (!storageReady) {
        return;
      }
      setPendingConversionPrompt(prompt);
      setNewTaskOpen(true);
    },
    clearPendingConversionPrompt: () => setPendingConversionPrompt(null),
  };
}
