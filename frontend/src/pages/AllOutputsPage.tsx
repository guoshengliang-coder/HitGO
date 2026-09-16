import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Job } from '../types';
import { formatSeconds } from '../lib/time';
import { fmtDateOr, fmtSize } from '../lib/datetime';
import { variantDef, type VariantKey } from '../types';

const PAGE = 100;

export function AllOutputsPage() {
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
        所有批次里已完成的成片，按生成时间从新到旧。点批次名可以回到那一批的回传页。
      </div>
      {error && <div className="error-text">{error}</div>}
      {jobs === null ? (
        <div className="empty">加载中…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">还没有完成的渲染任务。</div>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>视频</th>
                <th>批次</th>
                <th>变体</th>
                <th>分辨率</th>
                <th>时长</th>
                <th>大小</th>
                <th>生成时间</th>
                <th>文件</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const vd = variantDef(j.variant_key as VariantKey);
                return (
                  <tr key={j.id}>
                    <td>{j.video_name ?? j.video_id}</td>
                    <td>
                      <Link to={`/batches/${j.batch_id}/outputs`}>{j.batch_name ?? j.batch_id}</Link>
                    </td>
                    <td>
                      <span className="mono">{vd?.label ?? j.variant_key}</span>
                    </td>
                    <td className="mono">{j.output ? `${j.output.width}×${j.output.height}` : '—'}</td>
                    <td className="mono">{j.output ? formatSeconds(j.output.duration) : '—'}</td>
                    <td className="mono">{j.output ? fmtSize(j.output.size) : '—'}</td>
                    <td className="mono">{fmtDateOr(j.finished_at)}</td>
                    <td>
                      {j.output_url ? (
                        <a href={j.output_url} download target="_blank" rel="noreferrer">
                          下载
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!done && (
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => void load('more')} disabled={loading}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
