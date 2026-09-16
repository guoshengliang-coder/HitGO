// 产物页：唯一的成片列表（HIG-28 把原来的批次「已回传」页并进来）。
// - 不带参数：跨批次总表，按生成时间从新到旧，分页加载。
// - ?batch=<id>：只看这一批，多出「回传 JSON」列与「返回编辑」，有任务在跑时自动重拉。
// 两种视图同一张表、同一种行序，只差筛选与列。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { BatchDetail, Job } from '../types';
import { formatSeconds } from '../lib/time';
import { fmtDateOr, fmtSize } from '../lib/datetime';
import { latestJobIds, sortByFinishedDesc } from '../lib/outputs';
import { variantDef, type VariantKey } from '../types';

const PAGE = 100;
/** 批次视图还有任务在跑时的重拉间隔。进度弹窗用 1.5s，这里是看板，慢一点够用。 */
const POLL_MS = 2000;

export function AllOutputsPage() {
  const [params] = useSearchParams();
  const batchId = params.get('batch');
  // key 让切换筛选时整页重建，不把上一个视图的列表、展开状态带过去
  return batchId ? <BatchOutputs key={batchId} batchId={batchId} /> : <AllOutputs />;
}

function AllOutputs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [done, setDone] = useState(false); // 后端已经给完了
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // load 里要读「现在有多少条」，但不能把 jobs 放进依赖，否则每次追加都会重建 load
  const jobsRef = useRef<Job[] | null>(null);
  jobsRef.current = jobs;

  // offset 从当前已有条数算，而不是存一个页码：中途点「刷新」也不会算错。
  const load = useCallback(async (mode: 'reset' | 'more') => {
    setLoading(true);
    try {
      const offset = mode === 'reset' ? 0 : (jobsRef.current?.length ?? 0);
      const page = await api.allOutputs(PAGE, offset);
      if (!alive.current) return;
      setJobs((prev) => (mode === 'reset' || !prev ? page : [...prev, ...page]));
      setDone(page.length < PAGE);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load('reset');
    return () => {
      alive.current = false;
    };
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>产物</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void load('reset')} disabled={loading}>
          刷新
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        所有批次里已完成的成片，按生成时间从新到旧。点批次名只看那一批（含回传 JSON）。
      </div>
      {error && <div className="error-text">{error}</div>}
      <OutputsTable jobs={jobs} mode="all" />
      {jobs && jobs.length > 0 && !done && (
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void load('more')} disabled={loading}>
            {loading ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}

function BatchOutputs({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  // 一次拉全：产物列表 + 批次（要视频名）+ 全部任务（要知道还有没有在跑的）。
  // 只拉 outputs 的话，页面会停在「导出那一刻」的快照上——这正是 HIG-19 的现象。
  const load = useCallback(async () => {
    try {
      const [b, js, all] = await Promise.all([api.getBatch(batchId), api.batchOutputs(batchId), api.batchJobs(batchId)]);
      if (!alive.current) return;
      setBatch(b);
      // 批次端点按视频顺序返回、不带视频名；这里补上名字，并对齐成总表的时间倒序
      const named = js.map((j) => ({ ...j, video_name: j.video_name ?? b.videos.find((v) => v.id === j.video_id)?.name ?? null }));
      setJobs(sortByFinishedDesc(named));
      setPending(all.filter((j) => j.status === 'queued' || j.status === 'running').length);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [batchId]);

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

  return (
    <div className="page">
      <div className="page-head">
        <h1>产物 · {batch?.name ?? '…'}</h1>
        <span className="spacer" />
        {pending > 0 && <span className="muted small">还有 {pending} 个任务在跑，完成后会自动出现</span>}
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
        <Link to="/outputs" className="btn">
          查看全部
        </Link>
        <Link to={`/batches/${batchId}`} className="btn">
          返回编辑
        </Link>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        这一批已完成的成片，按生成时间从新到旧。原型不真正回调上游，「回传」列展示将要回传的内容（job.callback）。9:16
        为默认变体，语义为「替换原素材」，其余变体为派生新素材。同一视频重复导出会各留一行，「最新」是这次导出的那条。
      </div>
      {error && <div className="error-text">{error}</div>}
      <OutputsTable jobs={jobs} mode="batch" />
    </div>
  );
}

function OutputsTable({ jobs, mode }: { jobs: Job[] | null; mode: 'all' | 'batch' }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (jobs === null) return <div className="empty">加载中…</div>;
  if (jobs.length === 0) return <div className="empty">还没有完成的渲染任务。</div>;
  const latest = mode === 'batch' ? latestJobIds(jobs) : null;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>视频</th>
          {mode === 'all' && <th>批次</th>}
          <th>变体</th>
          <th>分辨率</th>
          <th>时长</th>
          <th>大小</th>
          <th>生成时间</th>
          <th>文件</th>
          {mode === 'batch' && <th>回传</th>}
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const vd = variantDef(j.variant_key as VariantKey);
          return (
            <tr key={j.id}>
              <td>{j.video_name ?? j.video_id}</td>
              {mode === 'all' && (
                <td>
                  <Link to={`/outputs?batch=${encodeURIComponent(j.batch_id)}`}>{j.batch_name ?? j.batch_id}</Link>
                </td>
              )}
              <td>
                <span className="mono">{vd?.label ?? j.variant_key}</span>
                {mode === 'batch' && vd?.note && <span className="muted small"> · {vd.note}</span>}
              </td>
              <td className="mono">{j.output ? `${j.output.width}×${j.output.height}` : '—'}</td>
              <td className="mono">{j.output ? formatSeconds(j.output.duration) : '—'}</td>
              <td className="mono">{j.output ? fmtSize(j.output.size) : '—'}</td>
              <td className="mono">
                {fmtDateOr(j.finished_at)}
                {latest?.has(j.id) && <span className="muted small"> · 最新</span>}
              </td>
              <td>
                {j.output_url ? (
                  <a href={j.output_url} download target="_blank" rel="noreferrer">
                    下载
                  </a>
                ) : (
                  '—'
                )}
              </td>
              {mode === 'batch' && (
                <td>
                  <button className="btn sm" onClick={() => setOpen((o) => ({ ...o, [j.id]: !o[j.id] }))}>
                    {open[j.id] ? '收起' : '查看回传 JSON'}
                  </button>
                  {open[j.id] && <pre className="json">{JSON.stringify(j.callback, null, 2)}</pre>}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
