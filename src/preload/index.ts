import { contextBridge, ipcRenderer } from "electron";

import type {
  ApprovalRequest,
  CreateTaskRequest,
  ProviderModelDiscoveryInput,
  ProviderInput,
  ProviderTestInput,
  QuickChatEventEnvelope,
  QuickChatRetryRequest,
  QuickChatSendRequest,
  RoutePreviewRequest,
  TaskEventEnvelope,
  ZoroApi,
} from "../shared/ipc";
import type { ModelSelection } from "../shared/taskRouting";
import { cloneQuickChatEventEnvelope } from "./quickChatEventValidation";
import { subscribeStorageStatus } from "./storageStatusSubscription";
import { cloneTaskEventEnvelope } from "./taskEventValidation";

let nextSubscription = 0;

const appApi: ZoroApi["app"] = {
  info: () => ipcRenderer.invoke("zoro:app:info"),
  subscribeStorageStatus: (listener) =>
    subscribeStorageStatus(ipcRenderer, listener),
};

const projectApi: ZoroApi["projects"] = {
  select: () => ipcRenderer.invoke("zoro:projects:select"),
  list: () => ipcRenderer.invoke("zoro:projects:list"),
};

const taskApi: ZoroApi["tasks"] = {
  list: (projectId?: string) =>
    ipcRenderer.invoke("zoro:tasks:list", { projectId }),
  get: (taskId: string) =>
    ipcRenderer.invoke("zoro:tasks:get", { taskId }),
  create: (input: CreateTaskRequest) =>
    ipcRenderer.invoke("zoro:tasks:create", input),
  pause: (taskId: string) =>
    ipcRenderer.invoke("zoro:tasks:pause", { taskId }),
  resume: (taskId: string) =>
    ipcRenderer.invoke("zoro:tasks:resume", { taskId }),
  retry: (taskId: string) =>
    ipcRenderer.invoke("zoro:tasks:retry", { taskId }),
  addMessage: (taskId: string, content: string) =>
    ipcRenderer.invoke("zoro:tasks:add-message", { taskId, content }),
  cancel: (taskId: string) =>
    ipcRenderer.invoke("zoro:tasks:cancel", { taskId }),
  resolveApproval: (input: ApprovalRequest) =>
    ipcRenderer.invoke("zoro:tasks:resolve-approval", {
      taskId: input.taskId,
      approvalId: input.approvalId,
      requestDigest: input.requestDigest,
      decision: input.decision,
    }),
  subscribe: (listener: (event: TaskEventEnvelope) => void) => {
    nextSubscription += 1;
    const subscriptionId = `renderer-${Date.now()}-${nextSubscription}`;
    const onEvent = (
      _event: Electron.IpcRendererEvent,
      envelope: unknown,
    ) => {
      const parsed = cloneTaskEventEnvelope(envelope);
      if (parsed?.subscriptionId === subscriptionId) {
        listener(parsed);
      }
    };
    ipcRenderer.on("zoro:tasks:event", onEvent);
    ipcRenderer.send("zoro:tasks:subscribe", subscriptionId);
    return () => {
      ipcRenderer.removeListener("zoro:tasks:event", onEvent);
      ipcRenderer.send("zoro:tasks:unsubscribe", subscriptionId);
    };
  },
};

const providerApi: ZoroApi["providers"] = {
  list: () => ipcRenderer.invoke("zoro:providers:list"),
  templates: () => ipcRenderer.invoke("zoro:providers:templates"),
  create: (input: ProviderInput & { apiKey: string }) =>
    ipcRenderer.invoke("zoro:providers:create", input),
  update: (id: string, input: ProviderInput) =>
    ipcRenderer.invoke("zoro:providers:update", { id, input }),
  test: (input: ProviderTestInput) =>
    ipcRenderer.invoke("zoro:providers:test", input),
  discoverModels: (input: ProviderModelDiscoveryInput) =>
    ipcRenderer.invoke("zoro:providers:discover-models", input),
  testSaved: (id: string) =>
    ipcRenderer.invoke("zoro:providers:test-saved", { id }),
  setDefault: (id: string) =>
    ipcRenderer.invoke("zoro:providers:set-default", { id }),
  remove: (id: string) =>
    ipcRenderer.invoke("zoro:providers:remove", { id }),
};

function exactSelection(selection: ModelSelection): ModelSelection {
  return selection.mode === "manual"
    ? { mode: "manual", providerId: selection.providerId }
    : { mode: selection.mode };
}

const routingApi: ZoroApi["routing"] = {
  get: () => ipcRenderer.invoke("zoro:routing:get"),
  update: (input) =>
    ipcRenderer.invoke("zoro:routing:update", {
      lightProviderId: input.lightProviderId,
      premiumProviderId: input.premiumProviderId,
    }),
  preview: (input: RoutePreviewRequest) =>
    ipcRenderer.invoke("zoro:routing:preview", {
      prompt: input.prompt,
      selection: exactSelection(input.selection),
    }),
};

const quickChatApi: ZoroApi["quickChat"] = {
  listSessions: () =>
    ipcRenderer.invoke("zoro:quick-chat:list-sessions"),
  createSession: () =>
    ipcRenderer.invoke("zoro:quick-chat:create-session"),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke("zoro:quick-chat:rename-session", {
      sessionId,
      title,
    }),
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke("zoro:quick-chat:delete-session", {
      sessionId,
    }),
  listMessages: (sessionId: string) =>
    ipcRenderer.invoke("zoro:quick-chat:list-messages", {
      sessionId,
    }),
  send: (input: QuickChatSendRequest) =>
    ipcRenderer.invoke("zoro:quick-chat:send", {
      sessionId: input.sessionId,
      prompt: input.prompt,
      selection: exactSelection(input.selection),
    }),
  cancel: (sessionId: string) =>
    ipcRenderer.invoke("zoro:quick-chat:cancel", { sessionId }),
  retry: (input: QuickChatRetryRequest) =>
    ipcRenderer.invoke("zoro:quick-chat:retry", {
      sessionId: input.sessionId,
      messageId: input.messageId,
      selection: exactSelection(input.selection),
    }),
  subscribe: (
    listener: (event: QuickChatEventEnvelope) => void,
  ) => {
    nextSubscription += 1;
    const subscriptionId =
      `renderer-quick-chat-${Date.now()}-${nextSubscription}`;
    let active = true;
    const onEvent = (
      _event: Electron.IpcRendererEvent,
      envelope: unknown,
    ) => {
      if (!active) {
        return;
      }
      const parsed = cloneQuickChatEventEnvelope(envelope);
      if (parsed?.subscriptionId === subscriptionId) {
        listener(parsed);
      }
    };
    ipcRenderer.on("zoro:quick-chat:event", onEvent);
    ipcRenderer.send("zoro:quick-chat:subscribe", { subscriptionId });
    return () => {
      if (!active) {
        return;
      }
      active = false;
      ipcRenderer.removeListener("zoro:quick-chat:event", onEvent);
      ipcRenderer.send("zoro:quick-chat:unsubscribe", {
        subscriptionId,
      });
    };
  },
};

const api: ZoroApi = Object.freeze({
  app: Object.freeze(appApi),
  projects: Object.freeze(projectApi),
  tasks: Object.freeze(taskApi),
  routing: Object.freeze(routingApi),
  quickChat: Object.freeze(quickChatApi),
  providers: Object.freeze(providerApi),
});

contextBridge.exposeInMainWorld("zoro", api);
