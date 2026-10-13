import {
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  HardDrive,
  PencilLine,
  PlusCircle,
  RefreshCw,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { ProjectSummary, ProviderTemplate } from "../../shared/domain";
import type {
  AppInfo,
  ProviderSummary,
  RoutingConfigView,
} from "../../shared/ipc";
import { CustomSelect } from "./CustomSelect";
import { IntegrationSettings } from "./IntegrationSettings";
import { ProviderDialog } from "./ProviderDialog";

interface SettingsViewProps {
  storageReady?: boolean;
  projects?: ProjectSummary[];
  onProvidersChanged?(): void;
}

interface ProviderEditor {
  provider?: ProviderSummary;
  template?: ProviderTemplate;
}

const KNOWN_SAFE_HEALTH_MESSAGES = new Set([
  "模型 API 鉴权失败，请检查 API Key。",
  "未找到模型或 API 地址，请检查 Base URL 和模型 ID。",
  "模型服务请求过于频繁，请稍后重试。",
  "模型服务暂时不可用。",
  "无法连接模型服务，请检查网络和 API 地址。",
  "模型连接测试失败，请检查配置后重试。",
]);

function providerDescription(provider: ProviderSummary): string {
  if (provider.kind === "kimi") {
    return "官方 Moonshot API";
  }
  try {
    return `OpenAI 兼容 · ${new URL(provider.baseUrl).host}`;
  } catch {
    return "OpenAI 兼容";
  }
}

function displayPortablePath(path: string, volumeName: string): string {
  const prefix = `/Volumes/${volumeName}/`;
  return path.startsWith(prefix)
    ? `${volumeName}/${path.slice(prefix.length)}`
    : path;
}

function safeDashboardUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function connectionCopy(provider: ProviderSummary): string {
  if (provider.connectionStatus === "connected") {
    return "连接正常";
  }
  if (provider.connectionStatus === "untested") {
    return "尚未测试";
  }
  return provider.connectionMessage !== null &&
    KNOWN_SAFE_HEALTH_MESSAGES.has(provider.connectionMessage)
    ? provider.connectionMessage
    : "连接失败，请重新测试。";
}

function lastTestedCopy(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null;
  }
  return `上次测试：${new Date(timestamp).toLocaleString("zh-CN")}`;
}

export function SettingsView({
  storageReady,
  projects = [],
  onProvidersChanged,
}: SettingsViewProps) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [templates, setTemplates] = useState<ProviderTemplate[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [routingConfig, setRoutingConfig] = useState<RoutingConfigView | null>(
    null,
  );
  const [lightProviderId, setLightProviderId] = useState("");
  const [premiumProviderId, setPremiumProviderId] = useState("");
  const [savingRouting, setSavingRouting] = useState(false);
  const [localStorageReady, setLocalStorageReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProviderEditor | null>(null);
  const [deleting, setDeleting] = useState<ProviderSummary | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const mutationsAllowed =
    localStorageReady && (storageReady === undefined || storageReady);

  useEffect(() => {
    let disposed = false;
    let storageStatusSeen = false;
    const unsubscribeStorage = window.zoro.app.subscribeStorageStatus(
      (status) => {
        if (disposed) {
          return;
        }
        storageStatusSeen = true;
        const ready = status.storageAvailable && !status.restartRequired;
        setLocalStorageReady(ready);
        if (!ready) {
          setEditing(null);
          setDeleting(null);
        }
      },
    );

    void Promise.all([
      window.zoro.providers.list(),
      window.zoro.providers.templates(),
      window.zoro.app.info(),
      window.zoro.routing.get(),
    ])
      .then(([loadedProviders, loadedTemplates, loadedAppInfo, loadedRouting]) => {
        if (disposed) {
          return;
        }
        setProviders(loadedProviders);
        setTemplates(loadedTemplates);
        setAppInfo(loadedAppInfo);
        setRoutingConfig(loadedRouting);
        setLightProviderId(loadedRouting.lightProviderId ?? "");
        setPremiumProviderId(loadedRouting.premiumProviderId ?? "");
        if (!storageStatusSeen) {
          setLocalStorageReady(
            loadedAppInfo.storageAvailable && !loadedAppInfo.restartRequired,
          );
        }
      })
      .catch((caught: unknown) => {
        if (!disposed) {
          setError(
            caught instanceof Error ? caught.message : "无法读取模型配置。",
          );
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
      unsubscribeStorage();
    };
  }, []);

  useEffect(() => {
    if (storageReady === false) {
      setEditing(null);
      setDeleting(null);
    }
  }, [storageReady]);

  const saved = (provider: ProviderSummary) => {
    setProviders((current) => {
      const withoutSaved = current.filter((item) => item.id !== provider.id);
      const next = [provider, ...withoutSaved];
      return provider.isDefault
        ? next.map((item) => ({
            ...item,
            isDefault: item.id === provider.id,
          }))
        : next;
    });
    setEditing(null);
    onProvidersChanged?.();
  };

  const setDefault = async (provider: ProviderSummary) => {
    if (!mutationsAllowed) {
      return;
    }
    try {
      await window.zoro.providers.setDefault(provider.id);
      setProviders((current) =>
        current.map((item) => ({
          ...item,
          isDefault: item.id === provider.id,
        })),
      );
      onProvidersChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "设置默认模型失败。");
    }
  };

  const testSavedProvider = async (provider: ProviderSummary) => {
    if (!mutationsAllowed) {
      return;
    }
    setTestingProviderId(provider.id);
    setError(null);
    let testFailed = false;
    try {
      await window.zoro.providers.testSaved(provider.id);
    } catch {
      testFailed = true;
      setError("连接测试失败，请检查模型配置。");
    }
    try {
      setProviders(await window.zoro.providers.list());
      onProvidersChanged?.();
    } catch {
      if (!testFailed) {
        setError("无法刷新模型连接状态。");
      }
    } finally {
      setTestingProviderId(null);
    }
  };

  const confirmDelete = async () => {
    if (deleting === null || !mutationsAllowed) {
      return;
    }
    try {
      await window.zoro.providers.remove(deleting.id);
      setProviders((current) =>
        current.filter((item) => item.id !== deleting.id),
      );
      setDeleting(null);
      onProvidersChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除模型失败。");
      setDeleting(null);
    }
  };

  const saveRouting = async () => {
    if (!mutationsAllowed || !lightProviderId || !premiumProviderId) {
      return;
    }
    setSavingRouting(true);
    setError(null);
    try {
      const updated = await window.zoro.routing.update({
        lightProviderId,
        premiumProviderId,
      });
      setRoutingConfig(updated);
      setLightProviderId(updated.lightProviderId ?? "");
      setPremiumProviderId(updated.premiumProviderId ?? "");
      onProvidersChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存自动模型路由失败。");
    } finally {
      setSavingRouting(false);
    }
  };

  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <header className="settings-header">
        <div>
          <h1 id="settings-title">模型与 API 管理</h1>
          <p>管理内置模型与自定义 API 提供商，配置后可在任务中选择使用。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={!mutationsAllowed}
          onClick={() => setEditing({})}
        >
          <PlusCircle aria-hidden="true" />
          添加模型 API
        </button>
      </header>

      {error !== null ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="portable-card" aria-labelledby="portable-title">
        <header>
          <span className="portable-icon" aria-hidden="true">
            <HardDrive />
          </span>
          <div>
            <h2 id="portable-title">移动硬盘存储</h2>
            <p>所有数据均锁定在移动硬盘，不会回退到 Mac 内置磁盘。</p>
          </div>
          <span
            className={
              mutationsAllowed
                ? "storage-status available"
                : "storage-status unavailable"
            }
          >
            {mutationsAllowed ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <TriangleAlert aria-hidden="true" />
            )}
            {mutationsAllowed ? "移动硬盘可用" : "移动硬盘不可用"}
          </span>
        </header>
        <dl className="portable-paths">
          <div>
            <dt>磁盘名称</dt>
            <dd>{appInfo === null ? "正在读取…" : appInfo.volumeName}</dd>
          </div>
          <div>
            <dt>数据位置</dt>
            <dd>
              {appInfo === null
                ? "正在读取…"
                : displayPortablePath(appInfo.dataRoot, appInfo.volumeName)}
            </dd>
          </div>
          <div>
            <dt>项目位置</dt>
            <dd>
              {appInfo === null
                ? "正在读取…"
                : displayPortablePath(appInfo.projectsRoot, appInfo.volumeName)}
              <small>项目只能存放在 Projects</small>
            </dd>
          </div>
        </dl>
      </section>

      <section className="quick-config" aria-labelledby="quick-config-title">
        <header>
          <div>
            <h2 id="quick-config-title">快速配置</h2>
            <p>模板只包含公开地址和说明，不包含 API Key。</p>
          </div>
        </header>
        <div className="template-grid">
          {templates.map((template) => (
            <button
              className="template-button"
              type="button"
              key={template.id}
              disabled={!mutationsAllowed}
              aria-label={`配置 ${template.name}`}
              onClick={() => setEditing({ template })}
            >
              <strong>{template.name}</strong>
              <small>{template.billingNote}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="routing-settings" aria-labelledby="routing-settings-title">
        <header>
          <div>
            <h2 id="routing-settings-title">自动模型路由</h2>
            <p>自动选择会按任务内容匹配模型；不会显示或保存 API Key。</p>
          </div>
        </header>
        <div className="routing-role-fields">
          <div className="field">
            <span className="field-label">轻量模型</span>
            <CustomSelect
              label="轻量模型"
              disabled={!mutationsAllowed || routingConfig === null}
              value={lightProviderId}
              placeholder="请选择轻量模型"
              options={providers.map((provider) => ({
                value: provider.id,
                label: `${provider.name} · ${provider.modelId}`,
              }))}
              onChange={setLightProviderId}
            />
          </div>
          <div className="field">
            <span className="field-label">高级模型</span>
            <CustomSelect
              label="高级模型"
              disabled={!mutationsAllowed || routingConfig === null}
              value={premiumProviderId}
              placeholder="请选择高级模型"
              options={providers.map((provider) => ({
                value: provider.id,
                label: `${provider.name} · ${provider.modelId}`,
              }))}
              onChange={setPremiumProviderId}
            />
          </div>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={
            !mutationsAllowed ||
            routingConfig === null ||
            savingRouting ||
            !lightProviderId ||
            !premiumProviderId
          }
          onClick={() => void saveRouting()}
        >
          {savingRouting ? "正在保存…" : "保存自动模型路由"}
        </button>
      </section>

      <IntegrationSettings mutationsAllowed={mutationsAllowed} projects={projects} />

      <div className="provider-table" role="table" aria-label="模型 API">
        <div className="provider-table-header" role="row">
          <span role="columnheader">名称</span>
          <span role="columnheader">模型 ID</span>
          <span role="columnheader">状态与计费</span>
          <span role="columnheader">操作</span>
        </div>
        {loading ? (
          <p className="providers-empty">正在读取模型配置…</p>
        ) : providers.length === 0 ? (
          <p className="providers-empty">
            尚未配置模型。添加 KIMI K3 或 OpenAI 兼容 API 后即可发起任务。
          </p>
        ) : (
          providers.map((provider) => {
            const dashboardUrl = safeDashboardUrl(provider.dashboardUrl);
            const lastTested = lastTestedCopy(provider.lastTestedAt);
            return (
              <div className="provider-row" role="row" key={provider.id}>
                <div className="provider-identity" role="cell">
                  <strong>
                    {provider.name}
                    {provider.isDefault ? (
                      <span className="default-label">默认</span>
                    ) : null}
                  </strong>
                  <small>{providerDescription(provider)}</small>
                </div>
                <div className="provider-model" role="cell">
                  <code>{provider.modelId}</code>
                  <small>••••{provider.keySuffix}</small>
                </div>
                <div
                  className={`provider-health ${provider.connectionStatus}`}
                  role="cell"
                >
                  <span>
                    {provider.connectionStatus === "connected" ? (
                      <CheckCircle2 aria-hidden="true" />
                    ) : (
                      <CircleHelp aria-hidden="true" />
                    )}
                    {connectionCopy(provider)}
                  </span>
                  {lastTested === null ? null : <small>{lastTested}</small>}
                  <small>{provider.billingNote}</small>
                  {dashboardUrl === null ? null : (
                    <a
                      href={dashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`打开 ${provider.name} 服务后台`}
                    >
                      服务后台
                      <ExternalLink aria-hidden="true" />
                    </a>
                  )}
                </div>
                <div className="provider-actions" role="cell">
                  <button
                    className="icon-button"
                    type="button"
                    disabled={!mutationsAllowed || testingProviderId !== null}
                    aria-label={`测试 ${provider.name} 连接`}
                    title="测试连接"
                    onClick={() => void testSavedProvider(provider)}
                  >
                    <RefreshCw
                      className={
                        testingProviderId === provider.id ? "spin" : undefined
                      }
                      aria-hidden="true"
                    />
                  </button>
                  {!provider.isDefault ? (
                    <button
                      className="icon-button"
                      type="button"
                      disabled={!mutationsAllowed}
                      aria-label={`将${provider.name}设为默认`}
                      title="设为默认"
                      onClick={() => void setDefault(provider)}
                    >
                      <Star aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    className="icon-button"
                    type="button"
                    disabled={!mutationsAllowed}
                    aria-label={`编辑${provider.name}`}
                    title="编辑"
                    onClick={() =>
                      setEditing({
                        provider,
                        template: templates.find(
                          (template) => template.baseUrl === provider.baseUrl,
                        ),
                      })
                    }
                  >
                    <PencilLine aria-hidden="true" />
                  </button>
                  <button
                    className="icon-button danger-icon"
                    type="button"
                    disabled={!mutationsAllowed}
                    aria-label={`删除${provider.name}`}
                    title="删除"
                    onClick={() => setDeleting(provider)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {editing !== null && mutationsAllowed ? (
        <ProviderDialog
          provider={editing.provider}
          template={editing.template}
          mutationsDisabled={!mutationsAllowed}
          onSaved={saved}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {deleting !== null && mutationsAllowed ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-provider-title"
          >
            <h2 id="delete-provider-title">删除“{deleting.name}”？</h2>
            <p>
              删除后将同时移除该模型的加密 API Key。此操作不会删除历史任务记录。
            </p>
            <footer className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void confirmDelete()}
              >
                确认删除
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
