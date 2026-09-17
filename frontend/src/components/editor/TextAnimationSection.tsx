// 文字图层的「动画」分组（HIG-40）：入场 / 出场 / 循环三栏，每栏选一个预设（含「无」）并调时长 / 周期。
// 选中预设后从这一段开头试播一次；曲线见 lib/textAnimation（与成片同一套）。

import { useEffect, useRef, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { postToSource } from '../../lib/time';
import { windowRange } from '../../lib/stickerMedia';
import {
  animationSummary,
  DEFAULT_LOOP_PERIOD,
  DEFAULT_PHASE_DURATION,
  hasAnimation,
  LOOP_PRESETS,
  MAX_ANIM_SECONDS,
  MOVE_PRESETS,
  OUT_LABEL,
  phaseLengths,
  previewSpan,
  type AnimTab,
} from '../../lib/textAnimation';
import { Num } from '../ui/Num';
import { Seg } from '../ui/Seg';
import { Section } from '../ui/Section';
import type { TextAnimation, TextAnimLoopPreset, TextAnimMovePreset, TextLayer } from '../../types';

const TABS: { v: AnimTab; label: string }[] = [
  { v: 'in', label: '入场' },
  { v: 'out', label: '出场' },
  { v: 'loop', label: '循环' },
];

const HELP =
  '入场在时段开头播放，出场在时段结尾播放，循环从入场结束一直到时段结束（和出场叠加）。时段为「全程」时就是整条视频的开头和结尾。画布上选中文字且暂停时显示静止状态，方便调整；播放或取消选中后按动画显示，成片与预览一致。';

export function TextAnimationSection({ layer }: { layer: TextLayer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const postDuration = usePostDuration();
  const [tab, setTab] = useState<AnimTab>('in');
  const stopTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
  }, []);

  const anim = layer.animation ?? {};
  const [a, b] = windowRange(layer.t, postDuration);
  const windowLen = Math.max(0, b - a);
  const [di, d] = phaseLengths(anim, windowLen);

  const write = (next: TextAnimation) => {
    updateLayer(layer.id, (l) => {
      if (l.type !== 'text') return;
      if (hasAnimation(next)) l.animation = next;
      else delete l.animation;
    });
  };

  /** 从这一栏的开头试播一段，放完暂停（试播期间画布按动画显示）。 */
  const preview = (next: TextAnimation, which: AnimTab) => {
    if (!hasAnimation(next) || windowLen <= 0) return;
    const [from, to] = previewSpan(next, which, [a, b]);
    const remove = useEditor.getState().currentSpec()?.trim.remove ?? [];
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    player.pause();
    player.seek(postToSource(from, remove));
    player.play();
    stopTimer.current = window.setTimeout(() => {
      stopTimer.current = null;
      player.pause();
    }, Math.max(200, (to - from) * 1000));
  };

  const pickMove = (which: 'in' | 'out', preset: TextAnimMovePreset | null) => {
    const next: TextAnimation = { ...anim };
    if (preset === null) delete next[which];
    else next[which] = { preset, duration: anim[which]?.duration ?? DEFAULT_PHASE_DURATION };
    write(next);
    if (preset !== null) preview(next, which);
  };
  const pickLoop = (preset: TextAnimLoopPreset | null) => {
    const next: TextAnimation = { ...anim };
    if (preset === null) delete next.loop;
    else next.loop = { preset, period: anim.loop?.period ?? DEFAULT_LOOP_PERIOD };
    write(next);
    if (preset !== null) preview(next, 'loop');
  };

  // 区间时段里入场 + 出场放不下时，成片按「入场优先」压缩（契约），这里提示实际用了多少
  const squeezed =
    (anim.in && Math.abs(di - (anim.in.duration ?? DEFAULT_PHASE_DURATION)) > 0.005) ||
    (anim.out && Math.abs(d - (anim.out.duration ?? DEFAULT_PHASE_DURATION)) > 0.005);

  const current = tab === 'loop' ? anim.loop?.preset ?? null : anim[tab]?.preset ?? null;
  const cards =
    tab === 'loop'
      ? LOOP_PRESETS.map((p) => ({ v: p.v as string, label: p.label }))
      : MOVE_PRESETS.map((p) => ({ v: p.v as string, label: (tab === 'out' && OUT_LABEL[p.v]) || p.label }));

  return (
    <Section
      id="text.animation"
      title="动画"
      bodyClass="stack"
      defaultOpen={false}
      changed={hasAnimation(layer.animation)}
      onReset={hasAnimation(layer.animation) ? () => write({}) : undefined}
      summary={<span>{animationSummary(layer.animation)}</span>}
      help={HELP}
    >
      <Seg
        label="动画类型"
        options={TABS.map((t) => ({ v: t.v, label: <>{t.label}{(t.v === 'loop' ? anim.loop : anim[t.v]) ? <span className="anim-dot" aria-hidden /> : null}</> }))}
        value={tab}
        onChange={setTab}
      />
      <div className="anim-grid" role="radiogroup" aria-label={`${TABS.find((t) => t.v === tab)?.label}动画`}>
        <button type="button" role="radio" aria-checked={current === null} className={`anim-card ${current === null ? 'active' : ''}`} onClick={() => (tab === 'loop' ? pickLoop(null) : pickMove(tab, null))}>
          <span className="anim-glyph none">T</span>
          <span>无</span>
        </button>
        {cards.map((c) => (
          <button
            key={c.v}
            type="button"
            role="radio"
            aria-checked={current === c.v}
            className={`anim-card ${current === c.v ? 'active' : ''}`}
            title={current === c.v ? '再点一次试播' : undefined}
            onClick={() => {
              if (current === c.v) preview(anim, tab);
              else if (tab === 'loop') pickLoop(c.v as TextAnimLoopPreset);
              else pickMove(tab, c.v as TextAnimMovePreset);
            }}
          >
            <span className={`anim-glyph ${tab} ${c.v}`}>T</span>
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      {tab !== 'loop' && anim[tab] && (
        <Num
          label={tab === 'in' ? '入场时长' : '出场时长'}
          value={anim[tab]!.duration ?? DEFAULT_PHASE_DURATION}
          scale={1}
          step={0.1}
          min={0.1}
          max={Math.min(MAX_ANIM_SECONDS, layer.t === 'all' ? MAX_ANIM_SECONDS : Math.max(0.1, windowLen - (tab === 'in' ? anim.out?.duration ?? 0 : anim.in?.duration ?? 0)))}
          suffix="s"
          onChange={(v) => write({ ...anim, [tab]: { ...anim[tab]!, duration: Math.round(v * 100) / 100 } })}
        />
      )}
      {tab === 'loop' && anim.loop && (
        <Num
          label="周期"
          title="一个完整循环的时长，越短越快"
          value={anim.loop.period ?? DEFAULT_LOOP_PERIOD}
          scale={1}
          step={0.1}
          min={0.2}
          max={MAX_ANIM_SECONDS}
          suffix="s"
          onChange={(v) => write({ ...anim, loop: { ...anim.loop!, period: Math.round(v * 100) / 100 } })}
        />
      )}
      {current !== null && (
        <button type="button" className="btn sm" onClick={() => preview(anim, tab)}>
          试播{TABS.find((t) => t.v === tab)?.label}
        </button>
      )}
      {squeezed && <div className="hint">时段只有 {windowLen.toFixed(1)}s，入场 + 出场放不下：实际入场 {di.toFixed(2)}s、出场 {d.toFixed(2)}s。</div>}
    </Section>
  );
}
