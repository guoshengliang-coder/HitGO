import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { BatchDetail, Job } from '../types';
import { formatSeconds } from '../lib/time';
import { fmtDateOr, fmtSize } from '../lib/datetime';
import { latestJobIds } from '../lib/outputs';
import { variantDef, type VariantKey } from '../types';

/** 还有任务在跑的时候的重拉间隔。进度弹窗用 1.5s，这里是看板，慢一点够用。 */
const POLL_MS = 2000;

export function OutputsPage() {
  const { id } = useParams<{ id: string }>();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const alive = useRef(true);

  // 一次拉全：产物列表 + 批次（要视频名）+ 全部任务（要知道还有没有在跑的）。
  // 只拉 outputs 的话，页面会停在「导出那一刻」的快照上——这正是 HIG-19 的现象。
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [b, js, all] = await Promise.all([api.getBatch(id), api.batchOutputs(id), api.batchJobs(id)]);
      if (!alive.current) return;
      setBatch(b);
      setJobs(js);
      setPending(all.filter((j) => j.status === 'queued' || j.status === 'running').length);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // 还有排队 / 渲染中的任务就继续重拉，全部落定就停。setTimeout 递归而不是
  // setInterval：慢请求不会叠着发。
  useEffect(() => {
    if (pending === 0) return;
    const t = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(t);
  }, [pending, jobs, load]);

  // 回到这个标签页时重拉一次。轮询只覆盖「到达时就有任务在跑」，而人常常是
  // 先开着这一页、去另一个标签页导出，回来发现还是老样子。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  const videoName = (vid: string) => batch?.videos.find((v) => v.id === vid)?.name ?? vid;
  const latest = latestJobIds(jobs ?? []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>已回传 · {batch?.name ?? '…'}</h1>
        <span className="spacer" />
        {pending > 0 && <span className="muted small">还有 {pending} 个任务在跑，完成后会自动出现</span>}
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
        <Link to={`/batches/${id}`} className="btn">
          返回编辑
        </Link>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        原型不真正回调上游，此处展示将要回传的内容（job.callback）。9:16 为默认变体，语义为「替换原素材」，其余变体为派生新素材。
        同一视频重复导出会各留一行，「最新」是这次导出的那条。
      </div>
      {error && <div className="error-text">{error}</div>}
      {jobs === null ? (
        <div className="empty">加载中…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">还没有完成的渲染任务。</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>视频</th>
              <th>变体</th>
              <th>分辨率</th>
              <th>时长</th>
              <th>大小</th>
              <th>生成时间</th>
              <th>文件</th>
              <th>回传</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const vd = variantDef(j.variant_key as VariantKey);
              return (
                <tr key={j.id}>
                  <td>{videoName(j.video_id)}</td>
                  <td>
                    <span className="mono">{vd?.label ?? j.variant_key}</span>
                    <span className="muted small"> · {vd?.note ?? ''}</span>
                  </td>
                  <td className="mono">{j.output ? `${j.output.width}×${j.output.height}` : '—'}</td>
                  <td className="mono">{j.output ? formatSeconds(j.output.duration) : '—'}</td>
                  <td className="mono">{j.output ? fmtSize(j.output.size) : '—'}</td>
                  <td className="mono">
                    {fmtDateOr(j.finished_at)}
                    {latest.has(j.id) && <span className="muted small"> · 最新</span>}
                  </td>
                  <td>{j.output_url ? <a href={j.output_url} download target="_blank" rel="noreferrer">下载</a> : '—'}</td>
                  <td>
                    <button className="btn sm" onClick={() => setOpen((o) => ({ ...o, [j.id]: !o[j.id] }))}>
                      {open[j.id] ? '收起' : '查看回传 JSON'}
                    </button>
                    {open[j.id] && <pre className="json">{JSON.stringify(j.callback, null, 2)}</pre>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
