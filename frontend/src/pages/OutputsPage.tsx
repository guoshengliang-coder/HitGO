import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { BatchDetail, Job } from '../types';
import { formatSeconds } from '../lib/time';
import { variantDef, type VariantKey } from '../types';

function fmtSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function OutputsPage() {
  const { id } = useParams<{ id: string }>();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [b, js] = await Promise.all([api.getBatch(id), api.batchOutputs(id)]);
        if (!alive) return;
        setBatch(b);
        setJobs(js);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const videoName = (vid: string) => batch?.videos.find((v) => v.id === vid)?.name ?? vid;

  return (
    <div className="page">
      <div className="page-head">
        <h1>已回传 · {batch?.name ?? '…'}</h1>
        <Link to={`/batches/${id}`} className="btn">
          返回编辑
        </Link>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        原型不真正回调上游，此处展示将要回传的内容（job.callback）。9:16 为默认变体，语义为「替换原素材」，其余变体为派生新素材。
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
