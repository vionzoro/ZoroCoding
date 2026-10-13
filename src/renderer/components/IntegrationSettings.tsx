import { useEffect, useRef, useState } from "react";

import type { ProjectSummary } from "../../shared/domain";
import {
  integrationOptionsSchema,
  integrationSettingsViewSchema,
  updateIntegrationSettingsRequestSchema,
  type IntegrationOptions,
  type IntegrationSettingsView,
} from "../../shared/ipc";
import { CustomSelect } from "./CustomSelect";

interface IntegrationSettingsProps {
  mutationsAllowed: boolean;
  projects: ProjectSummary[];
}

interface IntegrationCardProps extends IntegrationSettingsProps {
  id: string;
  title: string;
}

function IntegrationCard({
  id,
  title,
  mutationsAllowed,
  projects,
}: IntegrationCardProps) {
  const [saved, setSaved] = useState<IntegrationSettingsView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [options, setOptions] = useState<IntegrationOptions>(() =>
    integrationOptionsSchema.parse({}),
  );
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void window.zoro.integrations.get(id)
      .then((result) => {
        const view = integrationSettingsViewSchema.parse(result);
        if (disposed) return;
        setSaved(view);
        setEnabled(view.enabled);
        setEndpoint(view.endpoint);
        setOptions(integrationOptionsSchema.parse(view.options ?? {}));
      })
      .catch(() => {
        if (!disposed) setError("无法读取集成设置，请重新打开设置页。");
      });
    return () => {
      disposed = true;
      mounted.current = false;
    };
  }, [id]);

  useEffect(() => {
    if (!mutationsAllowed && tokenInput.current) {
      tokenInput.current.value = "";
      setClearToken(false);
    }
  }, [mutationsAllowed]);

  function changeOptions(patch: Partial<IntegrationOptions>) {
    setOptions((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  async function save() {
    if (!mutationsAllowed || !saved || busy) return;
    setError(null);
    setNotice(null);
    const token = tokenInput.current?.value.trim() ?? "";
    const request = updateIntegrationSettingsRequestSchema.safeParse({
      id,
      enabled,
      endpoint,
      options,
      ...(clearToken ? { token: "" } : token ? { token } : {}),
    });
    if (!request.success) {
      setError("请检查服务地址和令牌：远程地址须使用 HTTPS，不能包含账号、查询参数或片段；令牌至少 5 个字符。");
      return;
    }
    setBusy(true);
    try {
      const result = await window.zoro.integrations.update(request.data);
      const view = integrationSettingsViewSchema.parse(result);
      if (!mounted.current) return;
      setSaved(view);
      setEnabled(view.enabled);
      setEndpoint(view.endpoint);
      setOptions(integrationOptionsSchema.parse(view.options ?? {}));
      if (tokenInput.current) tokenInput.current.value = "";
      setClearToken(false);
      setNotice("已保存到本机配置；尚未接入运行时传输。");
    } catch {
      if (mounted.current) setError("保存集成设置失败，请检查存储状态后重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function closePreview() {
    setPreview(false);
    previewButton.current?.focus();
  }

  const draft = updateIntegrationSettingsRequestSchema.safeParse({
    id, enabled, endpoint, options,
  });
  const previewEndpoint = draft.success ? draft.data.endpoint : "服务地址无效";

  return (
    <section className="integration-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{title}</h3>
      {error ? (
        <p className="settings-error" role="alert">{error}</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <fieldset disabled={!mutationsAllowed || !saved || busy}>
        <legend hidden>{title}配置</legend>
        <label className="default-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              setNotice(null);
            }}
          />
          启用{title}
        </label>
        <label className="field">
          <span className="field-label">服务地址</span>
          <input
            type="url"
            value={endpoint}
            autoComplete="off"
            onChange={(event) => {
              setEndpoint(event.target.value);
              setNotice(null);
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">令牌</span>
          <input
            ref={tokenInput}
            type="password"
            autoComplete="new-password"
            disabled={clearToken}
            placeholder={saved?.keySuffix ? "已保存；留空保留原令牌" : "可选令牌"}
            onChange={() => setNotice(null)}
          />
        </label>
        <label className="default-checkbox">
          <input
            type="checkbox"
            checked={clearToken}
            onChange={(event) => {
              setClearToken(event.target.checked);
              if (tokenInput.current) tokenInput.current.value = "";
              setNotice(null);
            }}
          />
          清除已保存令牌
        </label>
        {id === "memory" ? (
          <div className="integration-toggles">
            <label className="default-checkbox">
              <input
                type="checkbox"
                checked={options.readEnabled}
                onChange={(event) => changeOptions({ readEnabled: event.target.checked })}
              />
              允许读取记忆
            </label>
            <label className="default-checkbox">
              <input
                type="checkbox"
                checked={options.writeEnabled}
                onChange={(event) => changeOptions({ writeEnabled: event.target.checked })}
              />
              允许写入记忆
            </label>
          </div>
        ) : (
          <div className="integration-fields">
            <div className="field">
              <span className="field-label">审查方式</span>
              <CustomSelect
                label="审查方式"
                value={options.reviewer}
                disabled={!mutationsAllowed || !saved || busy}
                options={[
                  { value: "manual", label: "手动确认" },
                  { value: "http", label: "HTTP 审查服务" },
                ]}
                onChange={(value) => changeOptions({ reviewer: value as IntegrationOptions["reviewer"] })}
              />
            </div>
            <div className="field">
              <span className="field-label">审查服务不可用时</span>
              <CustomSelect
                label="审查服务不可用时"
                value={options.unavailablePolicy}
                disabled={!mutationsAllowed || !saved || busy}
                options={[
                  { value: "block", label: "阻止操作" },
                  { value: "manual", label: "请求手动确认" },
                ]}
                onChange={(value) => changeOptions({ unavailablePolicy: value as IntegrationOptions["unavailablePolicy"] })}
              />
            </div>
          </div>
        )}
        <fieldset className="integration-projects">
          <legend>逐项目授权</legend>
          <p>只有勾选的项目才允许使用此集成；新项目默认不授权。</p>
          {projects.length === 0 ? (
            <p>尚无已授权项目。</p>
          ) : (
            projects.map((project) => (
              <label className="default-checkbox" key={project.id}>
                <input
                  type="checkbox"
                  checked={options.projectIds.includes(project.id)}
                  onChange={(event) => changeOptions({
                    projectIds: event.target.checked
                      ? [...options.projectIds, project.id]
                      : options.projectIds.filter((value) => value !== project.id),
                  })}
                />
                {project.name}
              </label>
            ))
          )}
        </fieldset>
        <div className="integration-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存集成设置"}
          </button>
          <button className="secondary-button" type="button" disabled>
            测试连接（暂不可用）
          </button>
        </div>
      </fieldset>
      <p>连接测试尚未接入。此页只保存配置，不会连接服务或发送项目数据。</p>
      <button
        ref={previewButton}
        className="secondary-button"
        type="button"
        onClick={() => setPreview(true)}
      >
        查看将发送的内容
      </button>
      {preview ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal integration-preview"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-preview-title`}
            onKeyDown={(event) => {
              if (event.key === "Escape") closePreview();
              // The close button is the dialog's only focusable control.
              if (event.key === "Tab") event.preventDefault();
            }}
          >
            <h2 id={`${id}-preview-title`}>{title}发送范围预览</h2>
            <p>这是当前表单的配置预览，并非真实请求。尚未接入传输；当前不会发送数据。</p>
            <dl>
              <dt>目的地址</dt><dd>{previewEndpoint || "未配置"}</dd>
              <dt>集成状态</dt><dd>{enabled ? "配置为启用" : "关闭"}</dd>
              <dt>授权项目数量</dt><dd>{options.projectIds.length}</dd>
              {id === "memory" ? <>
                <dt>读取范围</dt><dd>{options.readEnabled ? "检索关键词、任务摘要；服务返回相关记忆" : "不允许读取"}</dd>
                <dt>写入范围</dt><dd>{options.writeEnabled ? "用户确认的任务摘要、经验记录" : "不允许写入"}</dd>
              </> : <>
                <dt>审查方式</dt><dd>{options.reviewer === "http" ? "HTTP 审查服务" : "手动确认"}</dd>
                <dt>审查范围</dt><dd>{options.reviewer === "http" ? "待执行操作、命令或补丁、必要的任务摘要" : "不向外部审查服务发送"}</dd>
                <dt>不可用策略</dt><dd>{options.unavailablePolicy === "block" ? "阻止操作" : "请求手动确认"}</dd>
              </>}
            </dl>
            <p>未来发送前须预览并确认具体内容。令牌仅用于鉴权，不进入请求正文；不默认发送完整对话、文件、环境变量或项目绝对路径。</p>
            <footer className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                autoFocus
                onClick={closePreview}
              >
                关闭预览
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export function IntegrationSettings(props: IntegrationSettingsProps) {
  return (
    <section className="integration-settings" aria-labelledby="integrations-title">
      <h2 id="integrations-title">可选集成</h2>
      <p>默认关闭。启用并逐项目授权后，未来可将必要内容发送到您配置的外部服务。外部服务会收到这些内容，请先确认其隐私规则。记忆读写分别授权，审查不会自动允许操作。</p>
      <div className="integration-grid">
        <IntegrationCard {...props} id="memory" title="外部记忆" />
        <IntegrationCard {...props} id="approval-review" title="操作审查" />
      </div>
    </section>
  );
}
