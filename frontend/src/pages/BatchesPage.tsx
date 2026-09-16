import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Batch } from '../types';
import { IconExport, IconPen, IconPlus, IconTrash } from '../components/ui/Icons';
import { Seg } from '../components/ui/Seg';
import { fmtDate } from '../lib/datetime';
import { VIDEO_ACCEPT, mergeFiles, rejectedText } from '../lib/fileDrop';
import { matchesQuery } from '../lib/search';
import { sortBatches, type BatchSort } from '../lib/batches';
import { DropZone } from '../components/ui/DropZone';

/** 有批次在预处理时重拉列表的间隔（HIG-24），和编辑器里一致。 */
const POLL_MS = 2000;

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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BatchSort>('recent');
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

  // 刚上传的视频在后台预处理：卡片上的「准备中 N」轮询到归零为止，不用手动刷新（HIG-24）
  const preparing = batches?.some((b) => b.status_counts.preparing > 0) ?? false;
  useEffect(() => {
    if (!preparing) return;
    const t = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(t);
  }, [preparing, batches, load]);

  // 拖进来的视频加到待上传列表；表单没开就先打开（HIG-21）
  const addFiles = (accepted: File[], rejected: File[]) => {
    setError(rejectedText(rejected, 'mp4 / mov'));
    if (!accepted.length) return;
    setCreating(true);
    setFiles((prev) => mergeFiles(prev, accepted));
  };

  const rename = async (b: Batch) => {
    const next = window.prompt('批次名称', b.name)?.trim();
    if (!next || next === b.name) return;
    try {
      await api.renameBatch(b.id, next);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = batches ? sortBatches(batches.filter((b) => matchesQuery(b.name, query)), sort) : null;

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
    <DropZone className="page" accept={VIDEO_ACCEPT} disabled={busy} hint="松手把视频加入新批次" onFiles={addFiles}>
      <div className="page-head">
        <h1>批次列表</h1>
        <span className="spacer" />
        <Seg className="page-sort" label="排序" options={[{ v: 'recent', label: '最近创建' }, { v: 'name', label: '名称' }]} value={sort} onChange={setSort} />
        <input className="input search-input" type="search" placeholder="搜索批次名" aria-label="搜索批次名" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                accept={VIDEO_ACCEPT}
                onChange={(e) => {
                  setFiles((prev) => mergeFiles(prev, Array.from(e.target.files ?? [])));
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {files.length === 0 && <div className="hint">也可以直接把 mp4 / mov 文件拖到这个页面上。</div>}
          {files.length > 0 && (
            <div className="upload-list">
              {files.map((f) => (
                <div key={`${f.name}:${f.size}`} className="mono">
                  {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
                </div>
              ))}
              {!busy && (
                <button className="btn ghost sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setFiles([])}>
                  清空列表
                </button>
              )}
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
        <div className="empty">还没有批次。点击右上角「新建批次」，或直接把视频拖到这个页面上。</div>
      ) : shown!.length === 0 ? (
        <div className="empty">没有名称包含「{query.trim()}」的批次。</div>
      ) : (
        <div className="card-grid">
          {shown!.map((b) => (
            <div key={b.id} className="card batch-card" onClick={() => navigate(`/batches/${b.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/batches/${b.id}`)}>
              <div className="batch-top">
                <div className="name">{b.name}</div>
                {/* 重命名 / 删除平时藏起来，悬停或键盘聚焦才露出；产物是导航，常显 */}
                <span className="batch-acts" onClick={(e) => e.stopPropagation()}>
                  <button className="btn ghost icon sm" title="重命名" aria-label={`重命名 ${b.name}`} onClick={() => void rename(b)}>
                    <IconPen />
                  </button>
                  <button className="btn ghost icon sm danger" title="删除批次" aria-label={`删除批次 ${b.name}`} onClick={() => void remove(b)}>
                    <IconTrash />
                  </button>
                </span>
              </div>
              <div className="batch-states">
                {STATUS_ORDER.filter((k) => b.status_counts[k] > 0).map((k) => (
                  <span key={k} className={`vstate ${k}`}>
                    <i />
                    {STATUS_LABEL[k]} {b.status_counts[k]}
                  </span>
                ))}
                {STATUS_ORDER.every((k) => !b.status_counts[k]) && <span className="muted small">暂无视频</span>}
              </div>
              <div className="meta">
                <span className="mono">
                  {b.video_count} 条 · {fmtDate(b.created_at)}
                </span>
                <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); navigate(`/outputs?batch=${encodeURIComponent(b.id)}`); }}>
                  <IconExport /> 产物
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DropZone>
  );
}
