// 产物页：唯一的成片列表（HIG-28 把原来的批次「已回传」页并进来）。
// - 不带参数：跨批次总表，按生成时间从新到旧，分页加载。
// - ?batch=<id>：只看这一批，多出「回传 JSON」列与「返回编辑」，有任务在跑时自动重拉。
// 两种视图同一张表、同一种行序，只差筛选与列。
// - ?q=：按导出名称 / 批次名 / 视频名搜索（HIG-27）；总表交给后端过滤，批次视图在本地过滤。
// - 批量下载（HIG-47）：勾选已完成的行，打成一个 zip 由后端边打边传（lib/outputSelection、api.downloadOutputsZip）。
// - 播放（HIG-52）：已完成的行点「播放」，弹窗里直接放成片（OutputPlayerModal）。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { BatchDetail, Job } from '../types';
import { formatSeconds } from '../lib/time';
import { fmtDateOr, fmtSize } from '../lib/datetime';
import { IconExport } from '../components/ui/Icons';
import { audioMixSummary, jobWarning, outputFileName, sortByFinishedDesc, versionTags } from '../lib/outputs';
import { matchesQuery } from '../lib/search';
import { headState, isDownloadable, MAX_ZIP_JOBS, pruneSelection, selectionSummary, toggleAll, toggleOne } from '../lib/outputSelection';
import { variantDef, type VariantKey } from '../types';
import { OutputPlayerModal } from '../components/OutputPlayerModal';

const PAGE = 100;
/** 批次视图还有任务在跑时的重拉间隔。进度弹窗用 1.5s，这里是看板，慢一点够用。 */
const POLL_MS = 2000;
/** 搜索框停止输入多久后才发请求 / 写 URL。 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 搜索框与 URL 的 ?q= 同步：输入即时显示，停手一会儿再写进 URL（replace，不堆历史）。
 * 返回 [输入框的值, 设值, 已生效的搜索词]。
 */
function useSearchQuery(): [string, (v: string) => void, string] {
  const [params, setParams] = useSearchParams();
  const applied = params.get('q') ?? '';
  const [input, setInput] = useState(applied);
  useEffect(() => {
    if (input.trim() === applied) return;
    const t = window.setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (input.trim()) next.set('q', input.trim());
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [input, applied, setParams]);
  return [input, setInput, applied];
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input className="input search-input" type="search" placeholder="搜索导出名称 / 批次 / 视频" aria-label="搜索产物" value={value} onChange={(e) => onChange(e.target.value)} />;
}

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
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const alive = useRef(true);
  // load 里要读「现在有多少条」，但不能把 jobs 放进依赖，否则每次追加都会重建 load
  const jobsRef = useRef<Job[] | null>(null);
  jobsRef.current = jobs;
  const [input, setInput, query] = useSearchQuery();
  // 搜索词变了之后，还没回来的旧请求结果要丢掉，不然会盖住新结果
  const seq = useRef(0);

  // offset 从当前已有条数算，而不是存一个页码：中途点「刷新」也不会算错。
  const load = useCallback(async (mode: 'reset' | 'more') => {
    setLoading(true);
    const mine = ++seq.current;
    try {
      const offset = mode === 'reset' ? 0 : (jobsRef.current?.length ?? 0);
      const page = await api.allOutputs(PAGE, offset, query);
      if (!alive.current || mine !== seq.current) return;
      setJobs((prev) => (mode === 'reset' || !prev ? page : [...prev, ...page]));
      setDone(page.length < PAGE);
      setUpdatedAt(new Date());
      setError(null);
    } catch (e) {
      if (alive.current && mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, [query]);

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
        <SearchBox value={input} onChange={setInput} />
        <button className="btn" onClick={() => void load('reset')} disabled={loading} title="重新拉取列表">
          {loading ? '刷新中…' : updatedAt ? `更新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '刷新'}
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>所有批次已完成的成片，从新到旧；点批次名只看那一批。</div>
      {error && <div className="error-text">{error}</div>}
      <OutputsTable jobs={jobs} mode="all" emptyText={query ? `没有名称、批次或视频名包含「${query}」的产物。` : undefined} emptyAction={!query ? <Link to="/" className="btn"><IconExport /> 去批次列表导出</Link> : undefined} />
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
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const alive = useRef(true);
  const [input, setInput, query] = useSearchQuery();

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
      setUpdatedAt(new Date());
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
        <SearchBox value={input} onChange={setInput} />
        <span className="save-indicator" title="有任务在跑时每 2 秒自动重拉">
          <i className={pending > 0 ? 'busy' : ''} />
          {pending > 0 ? `${pending} 个任务在跑` : updatedAt ? `更新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '…'}
        </span>
        <button className="btn ghost sm" onClick={() => void load()} title="立即重拉">
          刷新
        </button>
        <Link to="/outputs" className="btn">
          查看全部
        </Link>
        <Link to={`/batches/${batchId}`} className="btn">
          返回编辑
        </Link>
      </div>
      <div className="hint" style={{ marginBottom: 12 }} title="原型不真正回调上游，「回传」列展示将要回传的内容（job.callback）。9:16 为默认变体，语义为「替换原素材」，其余变体为派生新素材。">
        这一批已完成的成片，从新到旧；同一视频重复导出各留一行，「最新」是最近的那条。
      </div>
      {error && <div className="error-text">{error}</div>}
      <OutputsTable
        jobs={jobs && jobs.filter((j) => matchesQuery(j.name, query) || matchesQuery(j.video_name, query) || matchesQuery(batch?.name, query))}
        mode="batch"
        batchName={batch?.name}
        emptyText={query && jobs?.length ? `这一批里没有名称或视频名包含「${query}」的产物。` : undefined}
      />
    </div>
  );
}

function OutputsTable({ jobs, mode, batchName, emptyText, emptyAction }: { jobs: Job[] | null; mode: 'all' | 'batch'; batchName?: string; emptyText?: string; emptyAction?: React.ReactNode }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [zipNote, setZipNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Job | null>(null);
  const headRef = useRef<HTMLInputElement>(null);
  // 刷新 / 搜索 / 加载更多之后，去掉已经不在列表里的勾
  useEffect(() => {
    if (jobs) setSelected((cur) => pruneSelection(cur, jobs));
  }, [jobs]);
  const head = jobs ? headState(selected, jobs) : 'none';
  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = head === 'some';
  }, [head]);
  if (jobs === null) return <div className="empty">加载中…</div>;
  if (jobs.length === 0) {
    return (
      <div className="empty">
        <div>{emptyText ?? '还没有完成的渲染任务。'}</div>
        {emptyAction && <div style={{ marginTop: 12 }}>{emptyAction}</div>}
      </div>
    );
  }
  // 同一视频同一变体重复导出时标出最新那条（HIG-26：旧成片不含后来加的音轨，容易听错）
  const versions = versionTags(jobs);
  const summary = selectionSummary(selected, jobs);
  const tooMany = summary.ids.length > MAX_ZIP_JOBS;
  const downloadZip = () => {
    setZipNote(null);
    const ok = api.downloadOutputsZip(summary.ids, (msg) => setZipNote(`打包下载失败：${msg}`));
    setZipNote(ok ? `正在打包 ${summary.ids.length} 个文件，浏览器会直接开始下载；文件多时要等一会儿。` : '演示模式没有后端，无法打包下载。');
  };

  return (
    <>
    <div className="outputs-bulk" role="toolbar" aria-label="批量下载">
      <span className="mono muted">已勾选 {summary.ids.length}{summary.bytes > 0 ? ` · 约 ${fmtSize(summary.bytes)}` : ''}</span>
      <button className="btn primary sm" disabled={summary.ids.length === 0 || tooMany} onClick={downloadZip} title={tooMany ? `一次最多打包 ${MAX_ZIP_JOBS} 个` : '打成一个 zip 下载（不压缩，大小约等于所选文件之和）'}>
        批量下载{summary.ids.length ? ` (${summary.ids.length})` : ''}
      </button>
      {summary.ids.length > 0 && (
        <button className="btn ghost sm" onClick={() => { setSelected([]); setZipNote(null); }}>
          清空勾选
        </button>
      )}
      {tooMany && <span className="warn-text small">一次最多打包 {MAX_ZIP_JOBS} 个，请少勾一些</span>}
      {zipNote && <span className="muted small">{zipNote}</span>}
    </div>
    <table className="table">
      <thead>
        <tr>
          <th className="col-check">
            <input ref={headRef} type="checkbox" checked={head === 'all'} onChange={() => setSelected(toggleAll(selected, jobs))} aria-label="全选可下载的产物" disabled={!jobs.some(isDownloadable)} />
          </th>
          <th>视频</th>
          <th>导出名称</th>
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
            <tr key={j.id} className={selected.includes(j.id) ? 'picked' : undefined}>
              <td className="col-check">
                <input type="checkbox" checked={selected.includes(j.id)} disabled={!isDownloadable(j)} onChange={() => setSelected(toggleOne(selected, j.id))} aria-label={`勾选 ${j.video_name ?? j.id}`} />
              </td>
              <td>
                {j.video_name ?? j.video_id}
                {audioMixSummary(j.output?.audio) && <div className="muted small">{audioMixSummary(j.output?.audio)}</div>}
                {jobWarning(j) && <div className="warn-text small" title={jobWarning(j) ?? undefined}>警告：{jobWarning(j)}</div>}
              </td>
              <td>{j.name ?? <span className="muted">—</span>}</td>
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
                {versions.get(j.id) === 'latest' && <span className="pill done" style={{ marginLeft: 6 }} title="同一视频同一变体里最近生成的一条">最新</span>}
                {versions.get(j.id) === 'older' && <span className="muted small" style={{ whiteSpace: 'nowrap' }} title="同一视频同一变体后来又导出过；这条不含之后的改动"> · 旧版本</span>}
              </td>
              <td>
                {j.output_url ? (
                  <span className="output-actions">
                    {isDownloadable(j) && (
                      <button className="btn sm" onClick={() => setPlaying(j)} title="在浏览器里直接播放这个成片">
                        播放
                      </button>
                    )}
                    {/* /media 与页面同源，download 属性里的文件名会生效（HIG-27） */}
                    <a href={j.output_url} download={outputFileName(j, { batchName })} target="_blank" rel="noreferrer">
                      下载
                    </a>
                  </span>
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
    {playing && <OutputPlayerModal job={playing} fileName={outputFileName(playing, { batchName })} onClose={() => setPlaying(null)} />}
    </>
  );
}
