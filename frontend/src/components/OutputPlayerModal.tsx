// 产物页预览弹窗：视频播放、图片显示；关闭即卸载媒体。
import { useEffect, useState } from 'react';
import type { Job } from '../types';
import { Modal } from './ui/Modal';
import { fitPlayerBox } from '../lib/outputPreview';

/** 弹窗头、脚和内边距占掉的高度 / 宽度（与 .modal-head / .modal-foot / .modal-body 的样式对应）。 */
const CHROME_H = 140;
const CHROME_W = 40;
const MAX_PLAYER_W = 1280;

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function OutputPlayerModal({ job, fileName, onClose }: { job: Job; fileName: string; onClose: () => void }) {
  const [vp, setVp] = useState(viewport);
  useEffect(() => {
    const onResize = () => setVp(viewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // .modal 最大 92vw × 88vh
  const box = fitPlayerBox(job.output?.width, job.output?.height, Math.min(MAX_PLAYER_W, vp.w * 0.92 - CHROME_W), vp.h * 0.88 - CHROME_H);
  return (
    <Modal
      title={<span className="mono">{fileName}</span>}
      onClose={onClose}
      width={Math.max(360, box.width + CHROME_W)}
      className="output-player"
      footer={
        <a className="btn" href={job.output_url ?? undefined} download={fileName} target="_blank" rel="noreferrer">
          下载
        </a>
      }
    >
      {job.output_format === 'png' || job.output_format === 'jpg' ? <img
        src={job.output_url ?? undefined}
        alt={fileName}
        style={{ display: 'block', width: box.width, height: box.height, margin: '0 auto', objectFit: 'contain' }}
      /> : <video
        key={job.id}
        src={job.output_url ?? undefined}
        controls
        autoPlay
        playsInline
        preload="metadata"
        style={{ display: 'block', width: box.width, height: box.height, margin: '0 auto', background: '#000' }}
      />}
    </Modal>
  );
}
