import { useEditor, usePostDuration, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { formatTimecode, frameDuration } from '../../lib/time';
import { hintFor } from '../../lib/shortcuts';
import { IconPause, IconPlay, IconStepBack, IconStepFwd } from '../ui/Icons';

export function Transport() {
  const playing = useEditor((s) => s.playing);
  const time = useEditor((s) => s.time);
  const step = useEditor((s) => s.step);
  const fps = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId)?.fps);
  const frame = frameDuration(fps);
  const postTime = usePostTime();
  const postDuration = usePostDuration();

  return (
    <div className="transport">
      <button className="btn icon" onClick={() => player.seek(time - frame)} aria-label="上一帧" title={hintFor('frame-prev')}>
        <IconStepBack />
      </button>
      <button className="btn icon" onClick={() => player.toggle()} aria-label={playing ? '暂停' : '播放'} title={hintFor('play')}>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <button className="btn icon" onClick={() => player.seek(time + frame)} aria-label="下一帧" title={hintFor('frame-next')}>
        <IconStepFwd />
      </button>
      <span className="time">
        {formatTimecode(postTime, fps)} / {formatTimecode(postDuration, fps)}
      </span>
      <span className="hint">{step === 1 ? 'I / O 设入出点 · Q / W 删左右' : step === 2 ? '拖动移动 · 角点缩放 · 方向键微移' : '点击变体预览选择变体'} · 按 ? 查看全部快捷键</span>
      <span className="spacer" />
      <span className="hint mono">源 {formatTimecode(time, fps)}</span>
    </div>
  );
}
