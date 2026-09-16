import { useCoverDuration, useEditor, usePostDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { formatTimecode, frameDuration } from '../../lib/time';
import { outputTime } from '../../lib/cover';
import { hintFor } from '../../lib/shortcuts';
import type { Step } from '../../lib/steps';
import { IconPause, IconPlay, IconStepBack, IconStepFwd } from '../ui/Icons';

const STEP_HINT: Record<Step, string> = {
  trim: 'I / O 设入出点 · Q / W 删左右',
  audio: '拖动音轨条调整时段 · Delete 删除音轨',
  text: '双击画布上的文字直接编辑 · ⌥ + 方向键微移',
  sticker: '拖动移动 · 角点缩放 · ⌥ + 方向键微移',
  subtitle: '导入字幕后可在时间线调时段 · 双击画布编辑',
  localize: '点句子时间跳播放头 · 套用后译文字幕可在时间线调时段',
};

export function Transport() {
  const playing = useEditor((s) => s.playing);
  const time = useEditor((s) => s.time);
  const step = useEditor((s) => s.step);
  const fps = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId)?.fps);
  const frame = frameDuration(fps);
  const remove = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.trim.remove : undefined));
  const postDuration = usePostDuration();
  // 左边是成片时间码（有封面时从封面算起）；右边是源时间，封面段里显示封面自己的位置
  const preroll = useCoverDuration();

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
        {formatTimecode(outputTime(time, remove ?? [], preroll), fps)} / {formatTimecode(postDuration + preroll, fps)}
      </span>
      <span className="hint">{STEP_HINT[step]} · 按 ? 查看全部快捷键</span>
      <span className="spacer" />
      <span className="hint mono">{time < 0 ? `封面 ${formatTimecode(time + preroll, fps)}` : `源 ${formatTimecode(time, fps)}`}</span>
    </div>
  );
}
