import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
} from "electron";

import { AgentRuntime } from "./agent/agentRuntime";
import { createMainWindow } from "./createWindow";
import {
  registerIpc,
  type IpcEventLike,
  type IpcMainLike,
} from "./ipc/registerIpc";
import { ModelGateway } from "./models/modelGateway";
import {
  openDatabaseWithRecovery,
  type ZoroDatabase,
} from "./persistence/database";
import { IntegrationSettingsRepository } from "./persistence/integrationSettingsRepository";
import { ProviderRepository } from "./persistence/providerRepository";
import { ModelRoutingRepository } from "./persistence/modelRoutingRepository";
import { QuickChatRepository } from "./persistence/quickChatRepository";
import { TaskRepository } from "./persistence/taskRepository";
import { QuickChatService } from "./quick-chat/quickChatService";
import { ModelRouter } from "./routing/modelRouter";
import { StorageWriteGate } from "./persistence/liveWriteGate";
import { SecretStore, type SecretCrypto } from "./secrets/secretStore";
import { FileTools } from "./tools/fileTools";
import { isProviderReferencedByResumableTask } from "./tasks/providerUsage";
import { PermissionEngine } from "./tools/permissionEngine";
import { ShellTool } from "./tools/shellTool";
import { ToolRegistry } from "./tools/toolRegistry";
import { preparePortableStorage } from "./portable/preparePortableStorage";
import { resolvePortableLayout } from "./portable/portableLayout";
import { startStorageMonitor } from "./portable/storageMonitor";
import {
  resolveDevelopmentPortableRoot,
  resolveE2eMode,
  resolveE2eStartupDelay,
} from "./runtimeMode";
import type { AppInfo } from "../shared/ipc";
import type { StorageStatus } from "../shared/ipc";
import { installWindowSafetyHandlers } from "./windowSafety";

let database: ZoroDatabase | null = null;
let unregisterIpc: (() => void) | null = null;
let runtime: AgentRuntime | null = null;
let quickChatService: QuickChatService | null = null;
let modelGateway: ModelGateway | null = null;
let databaseRecoveryNotice: {
  backupPath: string;
  message: string;
} | null = null;
let stopStorageMonitor: (() => void) | null = null;
let storageAvailable = true;
let storageRestartRequired = false;
let storageGeneration = 0;
const storageWriteGate = new StorageWriteGate(
  () => storageAvailable && !storageRestartRequired,
);

const isE2e = resolveE2eMode(
  process.env.ZORO_E2E === "1",
  app.isPackaged,
);
const e2eStartupDelayMs = resolveE2eStartupDelay(
  isE2e,
  process.env.ZORO_E2E_STARTUP_DELAY_MS,
);
const legacyUserData = app.getPath("userData");
const portableLayout = resolvePortableLayout({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  developmentRoot: resolveDevelopmentPortableRoot(
    app.isPackaged,
    process.env.ZORO_E2E_PORTABLE_ROOT,
  ),
});
app.setPath("userData", portableLayout.appDataRoot);

const appInfo: AppInfo = {
  portable: true,
  volumeName: path.basename(portableLayout.volumeRoot),
  dataRoot: portableLayout.dataRoot,
  projectsRoot: portableLayout.projectsRoot,
  get storageAvailable() {
    return storageAvailable;
  },
  get restartRequired() {
    return storageRestartRequired;
  },
};

function currentStorageStatus(): StorageStatus {
  return {
    storageAvailable,
    restartRequired: storageRestartRequired,
    generation: storageGeneration,
  };
}

function notifyStorageStatus(): void {
  const status = currentStorageStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send("zoro:app:storage-status", status);
      } catch {
        // One destroyed renderer must not prevent other windows from learning the state.
      }
    }
  }
}

function requiredE2eValue(name: string): string {
  const value = process.env[name];
  if (!isE2e || value === undefined || value.length === 0) {
    throw new Error(`Missing ${name} for ZoroCoding E2E mode`);
  }
  return value;
}

const e2eCrypto: SecretCrypto = {
  encryptString(value) {
    return Buffer.from(
      Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a),
    );
  },
  decryptString(value) {
    return Buffer.from(value.map((byte) => byte ^ 0x5a)).toString("utf8");
  },
};

const secureCrypto: SecretCrypto = {
  encryptString(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS 安全存储当前不可用，无法保存 API Key。");
    }
    return safeStorage.encryptString(value);
  },
  decryptString(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS 安全存储当前不可用，无法读取 API Key。");
    }
    return safeStorage.decryptString(value);
  },
};

const ipcAdapter: IpcMainLike = {
  handle(channel, listener) {
    ipcMain.handle(channel, (event, input) =>
      listener(event as IpcEventLike, input),
    );
  },
  on(channel, listener) {
    ipcMain.on(channel, listener as never);
  },
  removeHandler(channel) {
    ipcMain.removeHandler(channel);
  },
  removeListener(channel, listener) {
    ipcMain.removeListener(channel, listener as never);
  },
};

async function openApplicationWindow(): Promise<void> {
  const preload = path.join(__dirname, "../preload/index.js");
  const window = createMainWindow(preload);
  installWindowSafetyHandlers(window, () => runtime);

  if (app.isPackaged || isE2e) {
    await window.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));
  } else {
    await window.loadURL(
      process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173",
    );
  }
  if (databaseRecoveryNotice !== null) {
    const notice = databaseRecoveryNotice;
    databaseRecoveryNotice = null;
    await dialog.showMessageBox(window, {
      type: "warning",
      title: "ZoroCoding 已进入只读恢复模式",
      message: "本地数据库升级失败，原数据没有被覆盖。",
      detail: `${notice.message}\n\n备份位置：${notice.backupPath}`,
      buttons: ["知道了"],
    });
  }
}

async function initializeServices(expectedProjectsRoot: string): Promise<void> {
  const openedDatabase = openDatabaseWithRecovery(
    path.join(app.getPath("userData"), "zorocoding.sqlite"),
  );
  database = openedDatabase.database;
  if (
    openedDatabase.readOnly &&
    openedDatabase.backupPath !== null &&
    openedDatabase.recoveryMessage !== null
  ) {
    databaseRecoveryNotice = {
      backupPath: openedDatabase.backupPath,
      message: openedDatabase.recoveryMessage,
    };
  }
  const tasks = new TaskRepository(database, storageWriteGate);
  const providers = new ProviderRepository(database, storageWriteGate);
  const secrets = new SecretStore(
    path.join(app.getPath("userData"), "secrets"),
    isE2e ? e2eCrypto : secureCrypto,
    storageWriteGate,
  );
  const integrations = new IntegrationSettingsRepository(
    database,
    secrets,
    storageWriteGate,
  );
  if (!openedDatabase.readOnly) {
    await secrets.reconcile([
      ...providers.list().map((provider) => provider.secretRef),
      ...integrations.listSecretRefs(),
    ]);
  }
  modelGateway = new ModelGateway(
    providers,
    secrets,
    fetch,
    (providerId) =>
      isProviderReferencedByResumableTask(tasks, providerId),
  );
  runtime = new AgentRuntime({
    repository: tasks,
    modelGateway,
    createTools: (projectRoot, executionMode, requestApproval) => {
      const toolAbortController = new AbortController();
      const shell = new ShellTool(projectRoot);
      return new ToolRegistry(
        projectRoot,
        executionMode,
        new FileTools(projectRoot, { signal: toolAbortController.signal }),
        shell,
        new PermissionEngine(),
        requestApproval,
        toolAbortController,
      );
    },
    recoverInterrupted: !openedDatabase.readOnly,
  });

  if (isE2e) {
    const baseUrl = requiredE2eValue("ZORO_E2E_PROVIDER_BASE_URL");
    const apiKey = requiredE2eValue("ZORO_E2E_PROVIDER_API_KEY");
    const now = Date.now();
    const e2eProviders = [
      {
        id: "e2e-groq",
        name: "Groq",
        kind: "openai-compatible" as const,
        modelId: "zoro-e2e-light",
        isDefault: false,
      },
      {
        id: "e2e-kimi-k3",
        name: "KIMI K3",
        kind: "kimi" as const,
        modelId: "zoro-e2e-premium",
        isDefault: true,
      },
    ];
    for (const provider of e2eProviders) {
      if (
        provider.id === "e2e-groq" &&
        process.env.ZORO_E2E_SKIP_LIGHT_PROVIDER === "1"
      ) {
        continue;
      }
      if (providers.get(provider.id) !== null) {
        continue;
      }
      await modelGateway.createProvider({
        ...provider,
        baseUrl,
        contextLength: 128_000,
        headers: {
          "x-zoro-e2e-provider": provider.id,
        },
        apiKey,
        now,
      });
    }
  }

  const routing = new ModelRoutingRepository(database, storageWriteGate);
  if (!openedDatabase.readOnly) {
    routing.bootstrap(providers.list(), Date.now());
  }
  const modelRouter = new ModelRouter(routing, modelGateway);
  const quickChat = new QuickChatRepository(database, storageWriteGate);
  if (!openedDatabase.readOnly) {
    quickChat.recoverInterrupted();
  }
  quickChatService = new QuickChatService({
    repository: quickChat,
    modelRouter,
    modelGateway,
  });

  unregisterIpc = registerIpc({
    ipcMain: ipcAdapter,
    appInfo,
    dialog: {
      showOpenDialog: (options) =>
        isE2e
          ? Promise.resolve({
              canceled: false,
              filePaths: [requiredE2eValue("ZORO_E2E_PROJECT_PATH")],
            })
          : dialog.showOpenDialog(options),
    },
    tasks,
    providers,
    integrations,
    quickChat,
    quickChatService,
    routing,
    modelRouter,
    runtime,
    modelGateway,
    projectsRoot: portableLayout.projectsRoot,
    expectedProjectsRoot,
    readOnly: openedDatabase.readOnly,
    storageRestartRequired: () => storageRestartRequired,
    storageStatus: currentStorageStatus,
    e2eAppInfoDelayMs: e2eStartupDelayMs,
    createId: randomUUID,
  });
}

app.whenReady().then(async () => {
  let expectedProjectsRoot: string;
  try {
    await preparePortableStorage(portableLayout, legacyUserData);
    expectedProjectsRoot = await realpath(portableLayout.projectsRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      "ZoroCoding 无法访问移动硬盘存储",
      `无法准备外部存储：${portableLayout.dataRoot}\n\n${detail}`,
    );
    app.quit();
    return;
  }
  await initializeServices(expectedProjectsRoot);
  await openApplicationWindow();
  stopStorageMonitor = startStorageMonitor({
    appDataRoot: portableLayout.appDataRoot,
    projectsRoot: portableLayout.projectsRoot,
    onUnavailable: async () => {
      storageAvailable = false;
      storageRestartRequired = true;
      storageGeneration += 1;
      notifyStorageStatus();
      void Promise.allSettled([
        runtime?.interruptForStorageLoss() ?? Promise.resolve(),
        quickChatService?.interruptForStorageLoss() ?? Promise.resolve(),
        modelGateway?.interruptForStorageLoss() ?? Promise.resolve(),
      ]);
    },
    onRestored: () => {
      storageAvailable = true;
      storageGeneration += 1;
      notifyStorageStatus();
    },
    onError: (error) => {
      console.error("Portable storage monitor failed", error);
    },
  });

  app.on("activate", async () => {
    if (
      process.platform === "darwin" &&
      BrowserWindow.getAllWindows().length === 0
    ) {
      await openApplicationWindow();
    }
  });
});

app.on("will-quit", () => {
  stopStorageMonitor?.();
  stopStorageMonitor = null;
  void quickChatService?.interruptForStorageLoss();
  void modelGateway?.interruptForStorageLoss();
  unregisterIpc?.();
  unregisterIpc = null;
  runtime = null;
  quickChatService = null;
  modelGateway = null;
  database?.close();
  database = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
