import { useEffect } from 'react';
import { useCoverDuration, useEditor, usePostDuration } from '../../store/editor';
import { formatSeconds, formatTime } from '../../lib/time';
import { hintFor } from '../../lib/shortcuts';
import { estimateOutputBytes, formatBytes, qualityOf } from '../../lib/estimate';
import { defaultCropRect, describeCrop, isDefaultCrop } from '../../lib/crop';
import { countSafeZoneOverlaps } from '../../lib/spec';
import { IconClose, IconCutLeft, IconCutRight } from '../ui/Icons';
import { CoverSection } from './CoverSection';
import { variantDef, type FillMode, type OutputQuality } from '../../types';

const FILL_LABEL: Record<FillMode, string> = { blur: '模糊背景', color: '纯色', crop: '裁切' };
const FILL_TIP: Record<FillMode, string> = {
  blur: '源画面完整缩放放进 9:16，空出的部分用放大模糊的画面填满',
  color: '源画面完整缩放放进 9:16，空出的部分填纯色',
  crop: '只取源画面里的一个 9:16 窗口铺满成片',
};
const QUALITY_LABEL: Record<OutputQuality, string> = { standard: '标准', high: '高清' };
const QUALITY_TIP = '标准 = 更快更小（veryfast / crf 20）；高清 = 更慢更清晰（medium / crf 19）';

/** 成片画面（唯一的 9:16 输出）：填充方式、裁切范围、清晰度。原「输出」步骤里的设置搬到这里（HIG-8）。 */
function FrameSection() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const patchOutput = useEditor((s) => s.patchOutput);
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

  const def = variantDef('9x16');
  const aspect = def.width / def.height;
  const out = spec?.outputs.find((o) => o.variant_key === '9x16') ?? spec?.outputs[0];
  if (!video || !out) return null;
  const sameAspect = Math.abs(video.width / video.height - aspect) < 0.01;
  const landscape = video.width > video.height;
  const customCrop = !!out.crop && !isDefaultCrop(out.crop, video.width, video.height, aspect);
  const overlaps = spec ? countSafeZoneOverlaps(spec, zone, assets) : 0;
  const calibrated = Object.keys(calibration).length > 0;

  const setFill = (fill: FillMode) => {
    if (fill === out.fill) return;
    // 切到裁切时先写入缺省（居中 cover）窗口，画布与成片从一开始就一致
    patchOutput({ fill, ...(fill === 'color' ? { color: out.color ?? '#000000' } : {}), ...(fill === 'crop' && !out.crop ? { crop: defaultCropRect(video.width, video.height, aspect) } : {}) });
    if (fill !== 'crop' && cropEditing) setCropEditing(false);
  };

  return (
    <div className="section">
      <div className="section-title">
        <span>画面</span>
        <span className="mono muted">
          {def.width}×{def.height}
        </span>
      </div>
      {sameAspect ? (
        <div className="hint">源画面已是 9:16，直接铺满成片，不需要填充或裁切。</div>
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
                <input type="color" className="color" value={out.color ?? '#000000'} onChange={(e) => patchOutput({ color: e.target.value })} />
                <span className="mono small">{out.color ?? '#000000'}</span>
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
        <span className="small" style={{ color: overlaps ? 'var(--st-failed-fg)' : 'var(--st-done-fg)' }}>
          {overlaps ? `${overlaps} 个图层与遮挡区重叠` : '无图层与遮挡区重叠'}
        </span>
      </div>
    </div>
  );
}

export function TrimPanel() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const time = useEditor((s) => s.time);
  const inPoint = useEditor((s) => s.inPoint);
  const setInPoint = useEditor((s) => s.setInPoint);
  const setOutPoint = useEditor((s) => s.setOutPoint);
  const selected = useEditor((s) => s.selectedRangeIndex);
  const setSelected = useEditor((s) => s.setSelectedRange);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const removeBefore = useEditor((s) => s.removeBefore);
  const removeAfter = useEditor((s) => s.removeAfter);
  const canRemoveBefore = useEditor((s) => s.canRemoveBefore());
  const canRemoveAfter = useEditor((s) => s.canRemoveAfter());
  const postDuration = usePostDuration();
  const preroll = useCoverDuration();
  const remove = spec?.trim.remove ?? [];

  return (
    <div className="panel">
      <div className="panel-head">剪辑</div>
      <div className="panel-body">
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

        <div className="section">
          <div className="section-title">
            <span>已删除区间（源时间轴）</span>
            <span className="mono muted">{remove.length}</span>
          </div>
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
        </div>

        <CoverSection />

        <FrameSection />

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

        <div className="hint">
          删除区间基于源视频时间轴；文字 / 贴纸 / BGM / 口播的出现时段基于剪后时间轴（从正片第一帧算起，不含封面）。修改剪辑不会自动改动图层和音轨时段，文本、贴纸模块会对落在剪后时长之外的图层给出提示。源音轨、BGM、口播在「音频」模块里调。
        </div>
      </div>
    </div>
  );
}
