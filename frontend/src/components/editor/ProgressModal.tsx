import { useNavigate } from 'react-router-dom';
import { useEditor } from '../../store/editor';
import { Modal } from '../ui/Modal';
import { JOB_LABELS, Pill } from '../ui/Pill';
import { IconRetry } from '../ui/Icons';
import { VARIANT_DEFS } from '../../types';

export function ProgressModal() {
  const jobs = useEditor((s) => s.jobs);
  const videos = useEditor((s) => s.videos);
  const batch = useEditor((s) => s.batch);
  const close = useEditor((s) => s.closeProgress);
  const retry = useEditor((s) => s.retryJob);
  const navigate = useNavigate();

  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const name = (vid: string) => videos.find((v) => v.id === vid)?.name ?? vid;
  const label = (k: string) => VARIANT_DEFS.find((v) => v.key === k)?.label ?? k;

  return (
    <Modal
      title="渲染进度"
      onClose={close}
      width={640}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            已完成 <span className="mono">{done} / {jobs.length}</span> · 失败 <span className="mono">{failed}</span>
          </span>
          <button className="btn" onClick={close}>
            继续编辑其他视频
          </button>
          <button className="btn primary" onClick={() => navigate(batch ? `/outputs?batch=${encodeURIComponent(batch.id)}` : '/outputs')}>
            查看产物
          </button>
        </>
      }
    >
      <table className="progress-table">
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name(j.video_id)}>
                {name(j.video_id)}
              </td>
              <td className="mono">{label(j.variant_key)}</td>
              <td className="bar">
                <div className={`progress ${j.status}`}>
                  <i style={{ width: `${j.status === 'done' ? 100 : j.progress}%` }} />
                </div>
              </td>
              <td className="mono">{j.status === 'done' ? '100' : j.progress}%</td>
              <td>
                <Pill kind={j.status} label={JOB_LABELS[j.status]} />
              </td>
              <td className="err" title={j.error ?? undefined}>
                {j.status === 'failed' ? j.error : ''}
              </td>
              <td>
                {j.status === 'failed' && (
                  <button className="btn sm" onClick={() => void retry(j.id)}>
                    <IconRetry /> 重试
                  </button>
                )}
              </td>
            </tr>
          ))}
          {jobs.length === 0 && (
            <tr>
              <td className="muted">没有任务</td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
