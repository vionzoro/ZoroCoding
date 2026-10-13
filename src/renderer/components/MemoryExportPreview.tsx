import { useEffect, useState } from "react";
import type { MemoryExportApi, MemoryExportPreview as Preview, MemoryExportView } from "../../shared/memoryExport";

const STATE_COPY = {
  queued: "待发送（可撤回）",
  sent: "已发起发送，等待确认",
  acked: "目标已确认接收",
  unknown: "接收状态未知，不会自动重试",
};

export function MemoryExportPreview({ taskId, api }: { taskId: string; api?: MemoryExportApi }) {
  const [destinations, setDestinations] = useState<Array<{ id: string; label: string }>>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [records, setRecords] = useState<MemoryExportView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setPreview(null);
    setRecords([]);
    setDestinations([]);
    setError("");
    if (api) void Promise.all([api.destinations(), api.list(taskId)]).then(([targets, items]) => {
      if (active) { setDestinations(targets); setRecords(items); }
    }).catch(() => { if (active) setError("无法读取记忆导出状态。"); });
    return () => { active = false; };
  }, [taskId, api]);

  if (!api || (destinations.length === 0 && records.length === 0 && !error)) return null;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); } catch { setError("记忆导出操作失败，请检查目标配置或队列状态。"); }
    finally { setBusy(false); }
  }
  return (
    <section className="memory-export" aria-label="记忆导出">
      <strong>记忆导出</strong>
      <p>仅导出任务结果统计；不包含对话、文件内容、路径或工具输出。每个目标需单独同意。</p>
      {destinations.map((destination) => (
        <button className="secondary-button" key={destination.id} disabled={busy || records.some((item) => item.destinationId === destination.id)}
          onClick={() => void run(async () => setPreview(await api.preview(taskId, destination.id)))}>
          预览导出到 {destination.label}
        </button>
      ))}
      {preview ? <div>
        <p>目标：{preview.destinationLabel}</p>
        <p>同意后仅保存此预览内容；待发送记录会在下次启动时发送，发送前可撤回。</p>
        <pre>{JSON.stringify(preview.entry, null, 2)}</pre>
        <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
          await api.consent(preview.token);
          setPreview(null);
          setRecords(await api.list(taskId));
        })}>同意此目标并加入待发送队列</button>
        <button className="secondary-button" disabled={busy} onClick={() => setPreview(null)}>取消预览</button>
      </div> : null}
      <ul>{records.map((record) => <li key={record.clientWriteId}>
        {destinations.find((item) => item.id === record.destinationId)?.label ?? "未配置的目标"}：{STATE_COPY[record.state]}
        {record.state === "queued" ? <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
          const revoked = await api.revoke(record.clientWriteId);
          setRecords(await api.list(taskId));
          if (!revoked) setError("发送已开始，无法撤回。");
        })}>撤回同意</button> : null}
      </li>)}</ul>
      {records.some((item) => item.state === "queued") ? <>
        <p>待发送记录也会在下次启动时发送。接收状态未知的记录不会自动重试。</p>
        <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
          await api.flush(taskId);
          setRecords(await api.list(taskId));
        })}>发送此任务已同意的记录</button>
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
