// 文字图层的「动画」分组（HIG-40 / HIG-44 / HIG-45）：入场 / 出场 / 循环 / 逐字四栏，每栏选一个预设（含「无」）并调时长 / 周期。
// 入场 / 出场 / 循环的精细参数（速度曲线、距离、倍数、延迟、幅度）收在默认收起的「高级」里。
// 选中预设后从这一段开头试播一次；曲线见 lib/textAnimation、lib/textReveal（与成片同一套）。

import { useEffect, useRef, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { postToSource } from '../../lib/time';
import { windowRange } from '../../lib/stickerMedia';
import {
  animationSummary,
  BACK,
  DEFAULT_LOOP_PERIOD,
  DEFAULT_PHASE_DURATION,
  DEFAULT_REVEAL_DURATION,
  EASINGS,
  easingName,
  easingPoints,
  enterDelay,
  hasAnimation,
  isSlide,
  LOOP_PRESETS,
  MAX_ANIM_SECONDS,
  MAX_REVEAL_SECONDS,
  MOVE_PRESETS,
  OUT_LABEL,
  phaseLengths,
  POP_FROM,
  previewSpan,
  REVEAL_PRESETS,
  SLIDE,
  switchPreset,
  type AnimTab,
} from '../../lib/textAnimation';
import { Num } from '../ui/Num';
import { Seg } from '../ui/Seg';
import { Section } from '../ui/Section';
import type { TextAnimation, TextAnimEasing, TextAnimLoopPreset, TextAnimMovePreset, TextAnimPhase, TextLayer, TextRevealEasing, TextRevealPreset } from '../../types';

const TABS: { v: AnimTab; label: string }[] = [
  { v: 'in', label: '入场' },
  { v: 'out', label: '出场' },
  { v: 'loop', label: '循环' },
  { v: 'reveal', label: '逐字' },
];

const REVEAL_EASINGS: TextRevealEasing[] = ['linear', 'ease_in', 'ease_out', 'ease_in_out'];

const HELP =
  '入场在时段开头播放（可设延迟），出场在时段结尾播放，循环从入场结束一直到时段结束（和出场叠加）。逐字让文字按字依次出现，与入场同时开始，可以和其余三栏叠加。时段为「全程」时就是整条视频的开头和结尾。画布上选中文字且暂停时显示静止状态，方便调整；播放或取消选中后按动画显示，成片与预览一致。';

/** 曲线缩略图：上下两条参考线是 0 和 1，回弹 / 弹性会越过它们。 */
function EasingGlyph({ name, settle }: { name: TextAnimEasing; settle: boolean }) {
  const pts = easingPoints(name, settle)
    .map(([x, y]) => `${(2 + x * 32).toFixed(1)},${(21 - y * 16).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="anim-curve" viewBox="0 0 36 26" aria-hidden>
      <line x1="2" y1="21" x2="34" y2="21" />
      <line x1="2" y1="5" x2="34" y2="5" />
      <polyline points={pts} />
    </svg>
  );
}

export function TextAnimationSection({ layer }: { layer: TextLayer }) {
  // 滚动文字（HIG-50 大字报）与动画互斥（契约，后端 400），这类图层不显示动画分组
  if (layer.scroll) return null;
  return <TextAnimationBody layer={layer} />;
}

function TextAnimationBody({ layer }: { layer: TextLayer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const postDuration = usePostDuration();
  const [tab, setTab] = useState<AnimTab>('in');
  const [advanced, setAdvanced] = useState(false);
  const stopTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
  }, []);

  const anim = layer.animation ?? {};
  const [a, b] = windowRange(layer.t, postDuration);
  const windowLen = Math.max(0, b - a);
  const [di, d] = phaseLengths(anim, windowLen);
  const dl = enterDelay(anim, windowLen);

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
    else next[which] = switchPreset(anim[which], preset);
    write(next);
    if (preset !== null) preview(next, which);
  };
  const pickLoop = (preset: TextAnimLoopPreset | null) => {
    const next: TextAnimation = { ...anim };
    if (preset === null) delete next.loop;
    else next.loop = { ...anim.loop, preset, period: anim.loop?.period ?? DEFAULT_LOOP_PERIOD };
    write(next);
    if (preset !== null) preview(next, 'loop');
  };
  const pickReveal = (preset: TextRevealPreset | null) => {
    const next: TextAnimation = { ...anim };
    if (preset === null) delete next.reveal;
    else next.reveal = { ...anim.reveal, preset, duration: anim.reveal?.duration ?? DEFAULT_REVEAL_DURATION };
    write(next);
    if (preset !== null) preview(next, 'reveal');
  };
  /** 改入场 / 出场的某几个字段；传 undefined 的字段去掉（回到契约缺省）。 */
  const patchPhase = (which: 'in' | 'out', patch: Partial<TextAnimPhase>, replay = false) => {
    const cur = anim[which];
    if (!cur) return;
    const phase: TextAnimPhase = { ...cur, ...patch };
    for (const k of Object.keys(patch) as (keyof TextAnimPhase)[]) if (patch[k] === undefined) delete phase[k];
    const next = { ...anim, [which]: phase };
    write(next);
    if (replay) preview(next, which);
  };

  // 区间时段里延迟 + 入场 + 出场放不下时，成片按「延迟、入场优先」压缩（契约），这里提示实际用了多少
  const squeezed =
    (anim.in && Math.abs(di - (anim.in.duration ?? DEFAULT_PHASE_DURATION)) > 0.005) ||
    (anim.out && Math.abs(d - (anim.out.duration ?? DEFAULT_PHASE_DURATION)) > 0.005) ||
    (!!anim.in?.delay && Math.abs(dl - anim.in.delay) > 0.005);

  const current = tab === 'loop' ? anim.loop?.preset ?? null : tab === 'reveal' ? anim.reveal?.preset ?? null : anim[tab]?.preset ?? null;
  const cards =
    tab === 'loop'
      ? LOOP_PRESETS.map((p) => ({ v: p.v as string, label: p.label }))
      : tab === 'reveal'
        ? REVEAL_PRESETS.map((p) => ({ v: p.v as string, label: p.label }))
        : MOVE_PRESETS.map((p) => ({ v: p.v as string, label: (tab === 'out' && OUT_LABEL[p.v]) || p.label }));
  const pick = (v: string | null) => {
    if (tab === 'loop') pickLoop(v as TextAnimLoopPreset | null);
    else if (tab === 'reveal') pickReveal(v as TextRevealPreset | null);
    else pickMove(tab, v as TextAnimMovePreset | null);
  };
  const hasTab = (t: AnimTab) => !!(t === 'loop' ? anim.loop : t === 'reveal' ? anim.reveal : anim[t]);

  const phaseTab = tab === 'in' || tab === 'out' ? tab : null;
  const phase = phaseTab ? anim[phaseTab] : undefined;
  const advancedToggle = (
    <button type="button" className="btn sm ghost anim-adv-toggle" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
      {advanced ? '▾' : '▸'} 高级
    </button>
  );

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
        options={TABS.map((t) => ({ v: t.v, label: <>{t.label}{hasTab(t.v) ? <span className="anim-dot" aria-hidden /> : null}</> }))}
        value={tab}
        onChange={setTab}
      />
      <div className="anim-grid" role="radiogroup" aria-label={`${TABS.find((t) => t.v === tab)?.label}动画`}>
        <button type="button" role="radio" aria-checked={current === null} className={`anim-card ${current === null ? 'active' : ''}`} onClick={() => pick(null)}>
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
              else pick(c.v);
            }}
          >
            <span className={`anim-glyph ${tab} ${c.v}`}>{tab === 'reveal' ? '文字' : 'T'}</span>
            <span>{c.label}</span>
          </button>
        ))}
      </div>

      {phaseTab && phase && (
        <>
          <Num
            label={phaseTab === 'in' ? '入场时长' : '出场时长'}
            value={phase.duration ?? DEFAULT_PHASE_DURATION}
            scale={1}
            step={0.1}
            min={0.1}
            max={Math.min(MAX_ANIM_SECONDS, layer.t === 'all' ? MAX_ANIM_SECONDS : Math.max(0.1, windowLen - (phaseTab === 'in' ? (anim.out?.duration ?? 0) + (anim.in?.delay ?? 0) : (anim.in?.duration ?? 0) + (anim.in?.delay ?? 0))))}
            suffix="s"
            onChange={(v) => patchPhase(phaseTab, { duration: Math.round(v * 100) / 100 })}
          />
          {advancedToggle}
          {advanced && (
            <div className="anim-advanced stack">
              <div className="anim-grid" role="radiogroup" aria-label="速度曲线">
                {EASINGS.map((e) => {
                  const own = easingName({ preset: phase.preset }, phaseTab);
                  const on = easingName(phase, phaseTab) === e.v;
                  return (
                    <button
                      key={e.v}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`anim-card ${on ? 'active' : ''}`}
                      title={e.v === own ? `${e.label}（这个预设的默认曲线）` : e.label}
                      onClick={() => patchPhase(phaseTab, { easing: e.v === own ? undefined : e.v }, true)}
                    >
                      <EasingGlyph name={e.v} settle={phaseTab === 'in'} />
                      <span>{e.label}</span>
                    </button>
                  );
                })}
              </div>
              {isSlide(phase.preset) && (
                <>
                  <Num
                    label="距离"
                    title="滑动的距离，相对画布高"
                    value={phase.distance ?? SLIDE}
                    step={0.01}
                    min={0}
                    max={0.5}
                    onChange={(v) => patchPhase(phaseTab, { distance: Math.round(v * 1000) / 1000 })}
                  />
                  <label className="inline small">
                    <input type="checkbox" checked={phase.fade !== false} onChange={(e) => patchPhase(phaseTab, { fade: e.target.checked ? undefined : false }, true)} />
                    {phaseTab === 'in' ? '同时淡入' : '同时淡出'}
                  </label>
                </>
              )}
              {phase.preset === 'pop' && (
                <Num
                  label={phaseTab === 'in' ? '起始倍数' : '结束倍数'}
                  title={phaseTab === 'in' ? '弹入开始时的大小，大于 100% 就是从大缩回' : '缩小结束时的大小，大于 100% 就是放大消失'}
                  value={phase.scale ?? POP_FROM}
                  step={0.05}
                  min={0.1}
                  max={3}
                  onChange={(v) => patchPhase(phaseTab, { scale: Math.round(v * 100) / 100 })}
                />
              )}
              {easingName(phase, phaseTab) === 'back' && (
                <Num
                  label="回弹强度"
                  title="回弹曲线越过终点的程度，0 为不回弹"
                  value={phase.overshoot ?? BACK}
                  scale={1}
                  step={0.1}
                  min={0}
                  max={5}
                  suffix=""
                  onChange={(v) => patchPhase(phaseTab, { overshoot: Math.round(v * 100) / 100 })}
                />
              )}
              {phaseTab === 'in' && (
                <Num
                  label="入场延迟"
                  title="时段开始后等多久再入场；逐字显现也一起延后"
                  value={phase.delay ?? 0}
                  scale={1}
                  step={0.1}
                  min={0}
                  max={MAX_ANIM_SECONDS}
                  suffix="s"
                  onChange={(v) => patchPhase('in', { delay: v > 0 ? Math.round(v * 100) / 100 : undefined })}
                />
              )}
            </div>
          )}
        </>
      )}

      {tab === 'loop' && anim.loop && (
        <>
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
          {advancedToggle}
          {advanced && (
            <div className="anim-advanced stack">
              <Num
                label="幅度"
                title="相对预设幅度的倍数"
                value={anim.loop.amount ?? 1}
                step={0.1}
                min={0}
                max={3}
                onChange={(v) => {
                  const { amount: _, ...loop } = anim.loop!;
                  const amount = Math.round(v * 100) / 100;
                  write({ ...anim, loop: Math.abs(amount - 1) < 1e-9 ? loop : { ...loop, amount } });
                }}
              />
            </div>
          )}
        </>
      )}

      {tab === 'reveal' && anim.reveal && (
        <>
          <Num
            label="逐字时长"
            title="从第一个字出现到全部出现的时长"
            value={anim.reveal.duration ?? DEFAULT_REVEAL_DURATION}
            scale={1}
            step={0.1}
            min={0.1}
            max={MAX_REVEAL_SECONDS}
            suffix="s"
            onChange={(v) => write({ ...anim, reveal: { ...anim.reveal!, duration: Math.round(v * 100) / 100 } })}
          />
          <Seg
            label="单位"
            options={[
              { v: 'char', label: '按字' },
              { v: 'word', label: '按词' },
            ]}
            value={anim.reveal.unit ?? 'char'}
            onChange={(v) => {
              const { unit: _, ...reveal } = anim.reveal!;
              write({ ...anim, reveal: v === 'char' ? reveal : { ...reveal, unit: v } });
            }}
          />
          {anim.reveal.preset === 'typewriter' && (
            <label className="inline small">
              <input
                type="checkbox"
                checked={!!anim.reveal.cursor}
                onChange={(e) => {
                  const { cursor: _, ...rest } = anim.reveal!;
                  const next = { ...anim, reveal: e.target.checked ? { ...rest, cursor: true } : rest };
                  write(next);
                  if (e.target.checked) preview(next, 'reveal');
                }}
              />
              闪烁光标
            </label>
          )}
          {advancedToggle}
          {advanced && (
            <div className="anim-advanced anim-grid" role="radiogroup" aria-label="速度曲线">
              {EASINGS.filter((e) => (REVEAL_EASINGS as string[]).includes(e.v)).map((e) => {
                const on = (anim.reveal!.easing ?? 'linear') === e.v;
                return (
                  <button
                    key={e.v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`anim-card ${on ? 'active' : ''}`}
                    title={e.v === 'ease_out' ? '先快后慢' : e.v === 'ease_in' ? '先慢后快' : e.label}
                    onClick={() => {
                      const { easing: _, ...rest } = anim.reveal!;
                      const next = { ...anim, reveal: e.v === 'linear' ? rest : { ...rest, easing: e.v as TextRevealEasing } };
                      write(next);
                      preview(next, 'reveal');
                    }}
                  >
                    <EasingGlyph name={e.v} settle />
                    <span>{e.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {current !== null && (
        <button type="button" className="btn sm" onClick={() => preview(anim, tab)}>
          试播{TABS.find((t) => t.v === tab)?.label}
        </button>
      )}
      {squeezed && <div className="hint">时段只有 {windowLen.toFixed(1)}s，放不下：实际入场延迟 {dl.toFixed(2)}s、入场 {di.toFixed(2)}s、出场 {d.toFixed(2)}s。</div>}
    </Section>
  );
}
