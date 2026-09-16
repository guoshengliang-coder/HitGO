import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Batch } from '../types';
import { Pill } from '../components/ui/Pill';
import { IconPlus, IconTrash } from '../components/ui/Icons';
import { fmtDate } from '../lib/datetime';

const STATUS_ORDER: (keyof Batch['status_counts'])[] = ['preparing', 'ready', 'edited', 'rendering', 'done', 'failed'];
const STATUS_LABEL: Record<string, string> = { preparing: '准备中', ready: '未编辑', edited: '已编辑', rendering: '渲染中', done: '已完成', failed: '失败' };


export function BatchesPage() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setBatches(await api.listBatches());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !files.length) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api.createBatch(name.trim());
      setProgress(0);
      await api.uploadVideos(b.id, files, (f) => setProgress(f));
      navigate(`/batches/${b.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setProgress(null);
    }
  };

  const remove = async (b: Batch) => {
    if (!window.confirm(`删除批次「${b.name}」及其全部视频、任务和文件？此操作不可恢复。`)) return;
    try {
      await api.deleteBatch(b.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>批次列表</h1>
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>
          <IconPlus /> 新建批次
        </button>
      </div>

      {creating && (
        <form className="card form-col" style={{ marginBottom: 16 }} onSubmit={submit}>
          <div className="form-row">
            <label className="field" style={{ flex: 1 }}>
              批次名称
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：9 月新手引导 A/B" autoFocus />
            </label>
            <label className="field">
              视频文件（mp4 / mov，可多选）
              <input
                className="input"
                type="file"
                multiple
                accept="video/mp4,video/quicktime,.mp4,.mov"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
          </div>
          {files.length > 0 && (
            <div className="upload-list">
              {files.map((f) => (
                <div key={f.name} className="mono">
                  {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
                </div>
              ))}
            </div>
          )}
          {progress !== null && (
            <div className="form-col">
              <div className="progress">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="muted small">{progress < 1 ? `上传中 ${Math.round(progress * 100)}%` : '上传完成，正在进入编辑器…'}</div>
            </div>
          )}
          {error && <div className="error-text">{error}</div>}
          <div className="form-row">
            <button className="btn primary" type="submit" disabled={busy || !name.trim() || !files.length}>
              {busy ? '处理中…' : `创建并上传 ${files.length} 个文件`}
            </button>
            <button className="btn" type="button" onClick={() => setCreating(false)} disabled={busy}>
              取消
            </button>
          </div>
        </form>
      )}

      {!creating && error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}
      {batches === null ? (
        <div className="empty">加载中…</div>
      ) : batches.length === 0 ? (
        <div className="empty">还没有批次。点击右上角「新建批次」上传视频。</div>
      ) : (
        <div className="card-grid">
          {batches.map((b) => (
            <div key={b.id} className="card batch-card" onClick={() => navigate(`/batches/${b.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/batches/${b.id}`)}>
              <div className="name">{b.name}</div>
              <div className="chips">
                {STATUS_ORDER.filter((k) => b.status_counts[k] > 0).map((k) => (
                  <Pill key={k} kind={k} label={`${STATUS_LABEL[k]} ${b.status_counts[k]}`} />
                ))}
                {STATUS_ORDER.every((k) => !b.status_counts[k]) && <span className="muted small">暂无视频</span>}
              </div>
              <div className="meta">
                <span>
                  {b.video_count} 条视频 · <span className="mono">{fmtDate(b.created_at)}</span>
                </span>
                <span className="inline">
                  <a href={`/batches/${b.id}/outputs`} onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`/batches/${b.id}/outputs`); }}>
                    已回传
                  </a>
                  <button className="btn ghost icon sm danger" aria-label="删除批次" onClick={(e) => { e.stopPropagation(); void remove(b); }}>
                    <IconTrash />
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
