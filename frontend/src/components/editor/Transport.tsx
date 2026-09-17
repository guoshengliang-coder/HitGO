// 画布与时间线之间的工具条（docs/DESIGN.md §4.3）：
// [上一帧 | 播放 | 下一帧] 成片时间 / 总时长 · 时间线工具（删左 / 删右 / 拆分 / 删除） · 源时间 · 缩放。
// 原来时间线自己的表头（缩放滑杆 + 快捷键提示）并进这里，时间线省出一行。
// 时间用 m:ss.cc（§8.1 A3），不再显示帧号；快捷键提示收进「?」弹窗。
import { useCoverDuration, useEditor, usePostDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { formatTime, frameDuration } from '../../lib/time';
import { outputTime } from '../../lib/cover';
import { hintFor } from '../../lib/shortcuts';
import { MAX_PPS, MIN_PPS, TIMELINE_ZOOM_EVENT } from '../../lib/transportKeys';
import { IconFit, IconPause, IconPlay, IconStepBack, IconStepFwd } from '../ui/Icons';
import { TimelineTools } from './TimelineTools';

export function Transport() {
  const playing = useEditor((s) => s.playing);
  const time = useEditor((s) => s.time);
  const fps = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId)?.fps);
  const frame = frameDuration(fps);
  const remove = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.trim.remove : undefined));
  const hasSequence = useEditor((s) => !!(s.currentVideoId && s.specs[s.currentVideoId]?.sequence));
  const postDuration = usePostDuration();
  // 左边是成片时间（有封面时从封面算起）；右边是源时间，封面段里显示封面自己的位置
  const preroll = useCoverDuration();
  const timelinePps = useEditor((s) => s.timelinePps);
  const viewPps = useEditor((s) => s.timelineViewPps);
  const setTimelinePps = useEditor((s) => s.setTimelinePps);
  const zoomSlider = Math.round((Math.log(viewPps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
  // 滑杆只发事件，围绕视口中心缩放的逻辑在 Timeline 里（它才知道滚动位置）
  const onSlider = (v: number) => window.dispatchEvent(new CustomEvent(TIMELINE_ZOOM_EVENT, { detail: { pps: MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 1000) } }));

  return (
    <div className="transport">
      <span className="btn-group">
        <button className="btn icon" onClick={() => player.seek(time - frame)} aria-label="上一帧" title={hintFor('frame-prev')}>
          <IconStepBack />
        </button>
        <button className="btn icon" onClick={() => player.toggle()} aria-label={playing ? '暂停' : '播放'} title={hintFor('play')}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="btn icon" onClick={() => player.seek(time + frame)} aria-label="下一帧" title={hintFor('frame-next')}>
          <IconStepFwd />
        </button>
      </span>
      <span className="time">
        {formatTime(outputTime(time, remove ?? [], preroll))}
        <span className="muted"> / {formatTime(postDuration + preroll)}</span>
      </span>
      <span className="tp-sep" />
      <TimelineTools />
      <span className="spacer" />
      <span className="hint mono">{time < 0 ? `封面 ${formatTime(time + preroll)}` : `${hasSequence ? '拼接' : '源'} ${formatTime(time)}`}</span>
      <span className="tp-sep" />
      <span className="tp-zoom">
        <input type="range" min={0} max={1000} value={zoomSlider} onChange={(e) => onSlider(Number(e.target.value))} aria-label="时间轴缩放" title={hintFor('tl-zoom')} />
        <span className="mono muted">{Math.round(viewPps)} px/s</span>
        <button className="btn ghost sm" onClick={() => setTimelinePps(null)} disabled={timelinePps === null} title={hintFor('tl-fit')}>
          <IconFit /> 适应
        </button>
      </span>
    </div>
  );
}
