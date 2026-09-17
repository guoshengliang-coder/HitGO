// 剪辑模块右侧面板。HIG-17 做了功能分层：高频的剪辑操作常驻在最上面，
// 已删除区间 / 封面 / 成片画面 / 时长各自成一个可折叠分组，收起时标题行留一句摘要；
// 原先常驻在面板底部的那大段说明按语义拆进各分组标题旁的「?」里。

import { useEffect } from 'react';
import { useCoverDuration, useEditor, usePostDuration } from '../../store/editor';
import { formatSeconds, formatTime } from '../../lib/time';
import { estimateOutputBytes, formatBytes, qualityOf } from '../../lib/estimate';
import { defaultCropRect, describeCrop, isDefaultCrop } from '../../lib/crop';
import { countSafeZoneOverlaps, exportKeys, outputFor } from '../../lib/spec';
import { toggleExportVariant } from '../../lib/exportScope';
import { durationSummary, frameSummary, rangesSummary, FILL_LABEL, FILL_TIP, QUALITY_LABEL, QUALITY_TIP } from '../../lib/trimSummary';
import { IconClose } from '../ui/Icons';
import { Field } from '../ui/Num';
import { Seg } from '../ui/Seg';
import { Section } from '../ui/Section';
import { ColorPicker } from '../ui/ColorPicker';
import { CoverSection } from './CoverSection';
import { VARIANT_DEFS, variantDef, type FillMode, type OutputQuality, type VariantKey } from '../../types';

const RANGES_HELP = '这里的起止时间基于源视频时间轴，不是剪后时间轴。列表里点一段即选中，选中后可以用「删除选中区间」撤掉，也可以直接在时间轴上拖动区间边缘调整。';
const FRAME_HELP = '每个画幅单独设置；页签左边的勾表示导出时出这个画幅，勾选跟着视频保存，「导出」弹窗默认就按它来。填充决定源画面放不满画幅时怎么补；清晰度决定编码档位，大小是按码率估算的参考值，本批次有已完成任务时会按实际码率校准。非 9:16 画幅上文字、贴纸、遮盖默认跟着视频画面走，切到该页签后可在画布上单独微调。';
const DURATION_HELP = '文字 / 贴纸 / BGM / 口播的出现时段基于剪后时间轴（从正片第一帧算起，不含封面）。修改剪辑不会自动改动图层和音轨时段，文本、贴纸、字幕模块会对落在剪后时长之外的图层给出提示。源音轨、BGM、口播在「音频」模块里调。';

/** 成片画面：按画幅页签设置填充方式、裁切范围、清晰度（HIG-8 搬到这里，HIG-29 恢复多画幅）。页签与画布预览联动。 */
function FrameSection() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const patchOutput = useEditor((s) => s.patchOutput);
  const previewKey = useEditor((s) => s.previewVariantKey);
  const setPreviewVariant = useEditor((s) => s.setPreviewVariant);
  const setExportVariants = useEditor((s) => s.setExportVariants);
  const setCrop = useEditor((s) => s.setCrop);
  const cropEditing = useEditor((s) => s.cropEditing);
  const setCropEditing = useEditor((s) => s.setCropEditing);
  const calibration = useEditor((s) => s.outputCalibration);
  const loadOutputCalibration = useEditor((s) => s.loadOutputCalibration);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const assets = useEditor((s) => s.assets);
  const batchId = useEditor((s) => s.batch?.id);
  const postDuration = usePostDuration();
  const preroll = useCoverDuration();

  // 按本批次已完成任务的实际码率校准大小估算
  useEffect(() => {
    void loadOutputCalibration();
  }, [batchId, loadOutputCalibration]);

  const def = variantDef(previewKey);
  const aspect = def.width / def.height;
  const out = spec ? outputFor(spec, previewKey) : null;
  const isRef = previewKey === '9x16';
  if (!video || !out) return null;
  const sameAspect = Math.abs(video.width / video.height - aspect) < 0.01;
  const landscape = video.width > video.height;
  const customCrop = !!out.crop && !isDefaultCrop(out.crop, video.width, video.height, aspect);
  // 安全区按竖版平台定义，只对 9:16 检查
  const overlaps = spec && isRef ? countSafeZoneOverlaps(spec, zone, assets) : 0;
  const calibrated = Object.keys(calibration).length > 0;
  const exported: VariantKey[] = spec ? exportKeys(spec) : ['9x16'];

  const setFill = (fill: FillMode) => {
    if (fill === out.fill) return;
    // 切到裁切时先写入缺省（居中 cover）窗口，画布与成片从一开始就一致
    patchOutput({ fill, ...(fill === 'color' ? { color: out.color ?? '#000000' } : {}), ...(fill === 'crop' && !out.crop ? { crop: defaultCropRect(video.width, video.height, aspect) } : {}) });
    if (fill !== 'crop' && cropEditing) setCropEditing(false);
  };

  // 收起来之后摘要就是这块设置唯一的可见信息，所以安全区有重叠时也要在这一行看得见
  const summary = (
    <span className="mono">
      {def.label} · {frameSummary(out, postDuration + preroll, calibration, sameAspect)} · 导出 {exported.map((k) => variantDef(k).label).join(' / ')}
      {overlaps > 0 && <span style={{ color: 'var(--st-failed-fg)' }}> · {overlaps} 个图层越界</span>}
    </span>
  );

  return (
    <Section id="trim.frame" title="成片画面" defaultOpen={false} bodyClass="stack" summary={summary} help={FRAME_HELP}>
      <div className="chips variant-tabs" role="tablist" aria-label="画幅" style={{ display: 'flex' }}>
        {VARIANT_DEFS.map((d) => {
          const on = exported.includes(d.key);
          const configured = d.key !== '9x16' && !!spec?.outputs.some((o) => o.variant_key === d.key);
          return (
            <div key={d.key} className={`chip variant-tab ${previewKey === d.key ? 'active' : ''}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={`导出 ${d.label}`}
                className={`vt-check ${on ? 'on' : ''}`}
                title={on ? (exported.length > 1 ? `导出时出 ${d.label}（点击取消勾选）` : '至少导出一个画幅') : `勾选：导出时也出 ${d.label}（${d.width}×${d.height}）`}
                onClick={() => setExportVariants(toggleExportVariant(exported, d.key))}
              />
              <button type="button" role="tab" aria-selected={previewKey === d.key} className="vt-label" title={`预览并设置 ${d.label}：${d.width}×${d.height} · ${d.note}${configured ? ' · 已有设置' : ''}`} onClick={() => setPreviewVariant(d.key)}>
                {d.label}
                {configured && <span className="vt-dot" aria-hidden />}
              </button>
            </div>
          );
        })}
      </div>
      <div className="hint">
        {def.width}×{def.height}
        {exported.includes(previewKey) ? ' · 导出时会出这个画幅' : ' · 未勾选，导出时不出这个画幅'}
        {!isRef && '；画布正在预览它，图层默认跟着视频画面走，在画布上拖动只改这个画幅'}
      </div>
      {sameAspect ? (
        <div className="hint">源画面已是 {def.label}，直接铺满成片，不需要填充或裁切。</div>
      ) : (
        <>
          <Seg label="填充方式" options={(Object.keys(FILL_LABEL) as FillMode[]).map((f) => ({ v: f, label: FILL_LABEL[f], title: FILL_TIP[f] }))} value={out.fill} onChange={setFill} />
          {out.fill === 'color' && (
            <Field label="颜色">
              <ColorPicker label="纯色边颜色" value={out.color ?? '#000000'} onChange={(c) => patchOutput({ color: c })} />
            </Field>
          )}
          {out.fill === 'crop' && (
            <Field label="裁切" title="裁切窗口在源画面上的像素尺寸 @ 左上角">
              <span className="mono muted small">{customCrop && out.crop ? describeCrop(out.crop, video.width, video.height) : '居中（默认）'}</span>
              {customCrop && (
                <button className="btn ghost sm" onClick={() => setCrop(defaultCropRect(video.width, video.height, aspect))}>
                  居中
                </button>
              )}
              <button className={`btn sm ${cropEditing ? 'on' : ''}`} onClick={() => setCropEditing(!cropEditing)}>
                {cropEditing ? '完成' : '调整'}
              </button>
            </Field>
          )}
        </>
      )}
      {!sameAspect && landscape && out.fill !== 'crop' && <div className="hint">横屏源：若内容只在画面中间（两侧是模糊 / 装饰），把填充改为「裁切」并调整裁切范围，只取中间那一条。</div>}
      <div className="g2">
        <Field label="清晰度" title={QUALITY_TIP}>
          <Seg className="inner" label="清晰度" options={(['standard', 'high'] as OutputQuality[]).map((qk) => ({ v: qk, label: QUALITY_LABEL[qk] }))} value={qualityOf(out)} onChange={(quality) => patchOutput({ quality })} />
        </Field>
        <Field label="大小" title={calibrated ? '按本批次已完成任务的实际码率校准' : '按编码档位的典型码率估算'}>
          <span className="mono small">约 {formatBytes(estimateOutputBytes(out, postDuration + preroll, calibration))}</span>
        </Field>
      </div>
      <Field label="安全区">
        {isRef ? (
          <span className="small" style={{ color: overlaps ? 'var(--st-failed-fg)' : 'var(--st-done-fg)' }}>
            {overlaps ? `${overlaps} 个图层与遮挡区重叠` : '无图层越界'}
          </span>
        ) : (
          <span className="muted small">只在 9:16 检查</span>
        )}
      </Field>
    </Section>
  );
}

/** 已删除区间列表（源时间轴）。 */
function RangesSection() {
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const selected = useEditor((s) => s.selectedRangeIndex);
  const setSelected = useEditor((s) => s.setSelectedRange);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const remove = spec?.trim.remove ?? [];

  return (
    <Section
      id="trim.ranges"
      title="已删除区间"
      bodyClass="stack"
      summary={<span className="mono">{rangesSummary(remove) || '无'}</span>}
      help={RANGES_HELP}
    >
      {remove.length === 0 ? (
        <div className="hint">暂无。工具条里设入点 I、设出点 O，或 Q / W 删掉播放头左 / 右侧。</div>
      ) : (
        <div className="range-list">
          {remove.map((r, i) => (
            <div key={i} className={`range-item ${selected === i ? 'selected' : ''}`} onClick={() => setSelected(i)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(i)}>
              <span>
                {formatTime(r[0])} → {formatTime(r[1])}
              </span>
              <span className="muted">−{formatSeconds(r[1] - r[0])}</span>
              <button className="btn ghost icon sm" aria-label="删除区间" onClick={(e) => { e.stopPropagation(); deleteRange(i); }}>
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** 原始 / 剪后 / 删除合计，有封面时再加封面与成片时长。 */
function DurationSection() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const postDuration = usePostDuration();
  const preroll = useCoverDuration();

  return (
    <Section id="trim.duration" title="时长" bodyClass="stack" summary={<span className="mono">{durationSummary(postDuration, preroll)}</span>} help={DURATION_HELP}>
      <dl className="kv">
        <dt>原始时长</dt>
        <dd>{formatSeconds(video?.duration ?? 0, 2)}</dd>
        <dt>剪后时长</dt>
        <dd>{formatSeconds(postDuration, 2)}</dd>
        <dt>删除合计</dt>
        <dd>−{formatSeconds((video?.duration ?? 0) - postDuration, 2)}</dd>
        {preroll > 0 && (
          <>
            <dt>封面</dt>
            <dd>+{formatSeconds(preroll, 2)}</dd>
            <dt>成片时长</dt>
            <dd>{formatSeconds(postDuration + preroll, 2)}</dd>
          </>
        )}
      </dl>
    </Section>
  );
}

/** 剪辑面板只放"看"的东西：区间列表、封面、成片画面、时长。剪的动作（入出点 / 删左右 / 删除）都在画布下方的工具条里（§8.1 A2）。 */
export function TrimPanel() {
  const inPoint = useEditor((s) => s.inPoint);
  const setInPoint = useEditor((s) => s.setInPoint);

  return (
    <div className="panel">
      <div className="panel-head">剪辑</div>
      <div className="panel-body inspector">
        {inPoint !== null && (
          <div className="hint">
            入点已设在 <span className="mono">{formatTime(inPoint)}</span>（源时间），移动播放头后按 O 设出点。
            <button className="btn ghost sm" onClick={() => setInPoint(null)} style={{ marginLeft: 6 }}>
              取消
            </button>
          </div>
        )}

        <RangesSection />
        <CoverSection />
        <FrameSection />
        <DurationSection />
      </div>
    </div>
  );
}
