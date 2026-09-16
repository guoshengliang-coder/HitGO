// 剪辑模块右侧面板。HIG-17 做了功能分层：高频的剪辑操作常驻在最上面，
// 已删除区间 / 封面 / 成片画面 / 时长各自成一个可折叠分组，收起时标题行留一句摘要；
// 原先常驻在面板底部的那大段说明按语义拆进各分组标题旁的「?」里。

import { useEffect } from 'react';
import { useCoverDuration, useEditor, usePostDuration } from '../../store/editor';
import { formatSeconds, formatTime } from '../../lib/time';
import { hintFor } from '../../lib/shortcuts';
import { estimateOutputBytes, formatBytes, qualityOf } from '../../lib/estimate';
import { defaultCropRect, describeCrop, isDefaultCrop } from '../../lib/crop';
import { countSafeZoneOverlaps, outputFor } from '../../lib/spec';
import { durationSummary, frameSummary, rangesSummary, FILL_LABEL, FILL_TIP, QUALITY_LABEL, QUALITY_TIP } from '../../lib/trimSummary';
import { IconClose, IconCutLeft, IconCutRight } from '../ui/Icons';
import { Section } from '../ui/Section';
import { ColorPicker } from '../ui/ColorPicker';
import { CoverSection } from './CoverSection';
import { VARIANT_DEFS, variantDef, type FillMode, type OutputQuality } from '../../types';

const RANGES_HELP = '这里的起止时间基于源视频时间轴，不是剪后时间轴。列表里点一段即选中，选中后可以用「删除选中区间」撤掉，也可以直接在时间轴上拖动区间边缘调整。';
const FRAME_HELP = '每个画幅单独设置（导出时在「导出」里勾选出哪些画幅）。填充决定源画面放不满画幅时怎么补；清晰度决定编码档位，大小是按码率估算的参考值，本批次有已完成任务时会按实际码率校准。非 9:16 画幅上文字、贴纸、遮盖默认跟着视频画面走，切到该页签后可在画布上单独微调。';
const DURATION_HELP = '文字 / 贴纸 / BGM / 口播的出现时段基于剪后时间轴（从正片第一帧算起，不含封面）。修改剪辑不会自动改动图层和音轨时段，文本、贴纸、字幕模块会对落在剪后时长之外的图层给出提示。源音轨、BGM、口播在「音频」模块里调。';

/** 成片画面：按画幅页签设置填充方式、裁切范围、清晰度（HIG-8 搬到这里，HIG-29 恢复多画幅）。页签与画布预览联动。 */
function FrameSection() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const patchOutput = useEditor((s) => s.patchOutput);
  const previewKey = useEditor((s) => s.previewVariantKey);
  const setPreviewVariant = useEditor((s) => s.setPreviewVariant);
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

  const setFill = (fill: FillMode) => {
    if (fill === out.fill) return;
    // 切到裁切时先写入缺省（居中 cover）窗口，画布与成片从一开始就一致
    patchOutput({ fill, ...(fill === 'color' ? { color: out.color ?? '#000000' } : {}), ...(fill === 'crop' && !out.crop ? { crop: defaultCropRect(video.width, video.height, aspect) } : {}) });
    if (fill !== 'crop' && cropEditing) setCropEditing(false);
  };

  // 收起来之后摘要就是这块设置唯一的可见信息，所以安全区有重叠时也要在这一行看得见
  const summary = (
    <span className="mono">
      {def.label} · {frameSummary(out, postDuration + preroll, calibration, sameAspect)}
      {overlaps > 0 && <span style={{ color: 'var(--st-failed-fg)' }}> · {overlaps} 个图层越界</span>}
    </span>
  );

  return (
    <Section id="trim.frame" title="成片画面" defaultOpen={false} bodyClass="stack" summary={summary} help={FRAME_HELP}>
      <div className="chips variant-tabs" role="tablist" aria-label="画幅">
        {VARIANT_DEFS.map((d) => (
          <button key={d.key} role="tab" aria-selected={previewKey === d.key} className={`chip ${previewKey === d.key ? 'active' : ''}`} title={`${d.width}×${d.height} · ${d.note}`} onClick={() => setPreviewVariant(d.key)}>
            {d.label}
          </button>
        ))}
        <span className="mono muted small" style={{ marginLeft: 'auto' }}>
          {def.width}×{def.height}
        </span>
      </div>
      {!isRef && <div className="hint">画布正在预览 {def.label}：图层默认跟着视频画面走，在画布上拖动会只改这个画幅。导出时在「导出」里勾选 {def.label} 才会出这个文件。</div>}
      {sameAspect ? (
        <div className="hint">源画面已是 {def.label}，直接铺满成片，不需要填充或裁切。</div>
      ) : (
        <div className="prop-grid">
          <span>填充</span>
          <div className="inline" role="radiogroup" aria-label="填充方式">
            {(Object.keys(FILL_LABEL) as FillMode[]).map((f) => (
              <button key={f} role="radio" aria-checked={out.fill === f} className={`chip ${out.fill === f ? 'active' : ''}`} title={FILL_TIP[f]} onClick={() => setFill(f)}>
                {FILL_LABEL[f]}
              </button>
            ))}
          </div>
          {out.fill === 'color' && (
            <>
              <span>颜色</span>
              <div className="inline">
                <ColorPicker label="纯色边颜色" value={out.color ?? '#000000'} onChange={(c) => patchOutput({ color: c })} />
              </div>
            </>
          )}
          {out.fill === 'crop' && (
            <>
              <span>裁切</span>
              <div className="inline">
                <button className={`btn sm ${cropEditing ? 'on' : ''}`} onClick={() => setCropEditing(!cropEditing)}>
                  {cropEditing ? '完成裁切' : '调整裁切范围'}
                </button>
                <span className="mono muted small" title="裁切窗口在源画面上的像素尺寸 @ 左上角">
                  {customCrop && out.crop ? describeCrop(out.crop, video.width, video.height) : '居中（默认）'}
                </span>
                {customCrop && (
                  <button className="btn ghost sm" onClick={() => setCrop(defaultCropRect(video.width, video.height, aspect))}>
                    居中
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {!sameAspect && landscape && out.fill !== 'crop' && <div className="hint">横屏源：若内容只在画面中间（两侧是模糊 / 装饰），把填充改为「裁切」并调整裁切范围，只取中间那一条。</div>}
      <div className="prop-grid">
        <span>清晰度</span>
        <div className="inline">
          <span className="chips" title={QUALITY_TIP} role="radiogroup" aria-label="清晰度">
            {(['standard', 'high'] as OutputQuality[]).map((qk) => (
              <button key={qk} role="radio" aria-checked={qualityOf(out) === qk} className={`chip ${qualityOf(out) === qk ? 'active' : ''}`} onClick={() => patchOutput({ quality: qk })}>
                {QUALITY_LABEL[qk]}
              </button>
            ))}
          </span>
          <span className="spacer" />
          <span className="mono muted small" title={calibrated ? '按本批次已完成任务的实际码率校准' : '按编码档位的典型码率估算'}>
            约 {formatBytes(estimateOutputBytes(out, postDuration + preroll, calibration))}（估算）
          </span>
        </div>
        <span>安全区</span>
        {isRef ? (
          <span className="small" style={{ color: overlaps ? 'var(--st-failed-fg)' : 'var(--st-done-fg)' }}>
            {overlaps ? `${overlaps} 个图层与遮挡区重叠` : '无图层与遮挡区重叠'}
          </span>
        ) : (
          <span className="muted small">安全区按竖版平台定义，只在 9:16 检查</span>
        )}
      </div>
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
        <div className="hint">暂无。播放到要删除的起点按 I，再到终点按 O；Q / W 一键删掉播放头左侧 / 右侧；也可以直接在时间轴上拖动区间边缘调整。</div>
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
    <Section id="trim.duration" title="时长" summary={<span className="mono">{durationSummary(postDuration, preroll)}</span>} help={DURATION_HELP}>
      <dl className="kv span2">
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

export function TrimPanel() {
  const time = useEditor((s) => s.time);
  const inPoint = useEditor((s) => s.inPoint);
  const setInPoint = useEditor((s) => s.setInPoint);
  const setOutPoint = useEditor((s) => s.setOutPoint);
  const selected = useEditor((s) => s.selectedRangeIndex);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const removeBefore = useEditor((s) => s.removeBefore);
  const removeAfter = useEditor((s) => s.removeAfter);
  const canRemoveBefore = useEditor((s) => s.canRemoveBefore());
  const canRemoveAfter = useEditor((s) => s.canRemoveAfter());

  return (
    <div className="panel">
      <div className="panel-head">剪辑</div>
      <div className="panel-body">
        {/* 高频操作常驻，不参与折叠 */}
        <div className="inline">
          <button className="btn" onClick={() => setInPoint(time)} title={hintFor('in')}>
            设入点 <span className="mono muted">I</span>
          </button>
          <button className="btn" onClick={() => setOutPoint(time)} title={hintFor('out')} disabled={inPoint === null}>
            设出点 <span className="mono muted">O</span>
          </button>
          <button className="btn" onClick={removeBefore} disabled={!canRemoveBefore} title={hintFor('remove-before')}>
            <IconCutLeft /> 删左 <span className="mono muted">Q</span>
          </button>
          <button className="btn" onClick={removeAfter} disabled={!canRemoveAfter} title={hintFor('remove-after')}>
            <IconCutRight /> 删右 <span className="mono muted">W</span>
          </button>
          <button className="btn danger" onClick={() => selected !== null && deleteRange(selected)} disabled={selected === null} title={hintFor('delete-range')}>
            删除选中区间
          </button>
        </div>
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
