import { useState } from 'react';
import { useEditor, type ApplyModule } from '../../store/editor';
import { Pill, videoPillKind } from '../ui/Pill';
import { Modal } from '../ui/Modal';
import { formatSeconds } from '../../lib/time';
import type { EditSpec } from '../../types';
import { isDefaultAudio } from '../../lib/audioTracks';

const MODULES: { key: ApplyModule; label: string; desc: string }[] = [
  { key: 'trim', label: '剪辑', desc: '删除区间（目标更短时丢弃超出部分）' },
  { key: 'layers', label: '图层', desc: '文字与贴纸图层及其时段（两类一起套用）' },
  { key: 'outputs', label: '画面', desc: '填充方式、裁切范围与清晰度' },
  { key: 'audio', label: '音频', desc: '源音轨音量与 BGM / 口播音轨（源没设置时清掉目标的）' },
];

/** 目标草稿里该模块是否已有"非默认"配置（会被覆盖）。 */
export function moduleConfigured(spec: EditSpec | undefined, module: ApplyModule): boolean {
  if (!spec) return false;
  if (module === 'trim') return spec.trim.remove.length > 0;
  if (module === 'layers') return spec.layers.length > 0;
  if (module === 'audio') return !isDefaultAudio(spec.audio);
  return spec.outputs.some((o) => o.fill !== 'blur' || o.quality === 'high');
}

export function ApplyDialog({ targetIds, onClose, defaultModules }: { targetIds: string[]; onClose: () => void; defaultModules?: ApplyModule[] }) {
  const [modules, setModules] = useState<ApplyModule[]>(defaultModules ?? ['trim', 'layers', 'outputs', 'audio']);
  const [styleOnly, setStyleOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const applyToTargets = useEditor((s) => s.applyToTargets);
  const currentId = useEditor((s) => s.currentVideoId);
  const specs = useEditor((s) => s.specs);
  const targets = targetIds.filter((id) => id !== currentId);
  const overwriteCount = (m: ApplyModule) => targets.filter((id) => moduleConfigured(specs[id], m)).length;
  return (
    <Modal
      title={`批量应用当前配置 → ${targets.length} 条`}
      onClose={onClose}
      className="apply-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || !modules.length || !targets.length}
            onClick={async () => {
              setBusy(true);
              await applyToTargets(targets, modules, { layerMode: styleOnly ? 'style_only' : 'replace' });
              setBusy(false);
              onClose();
            }}
          >
            {busy ? '应用中…' : '应用'}
          </button>
        </>
      }
    >
      <div className="hint">把当前视频的配置深拷贝到勾选的其他视频；目标已有的对应模块会被覆盖。应用后可在提示条里「撤销本次批量应用」。</div>
      {MODULES.map((m) => {
        const n = overwriteCount(m.key);
        return (
          <div key={m.key}>
            <label className="inline" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={modules.includes(m.key)} onChange={(e) => setModules((ms) => (e.target.checked ? [...ms, m.key] : ms.filter((x) => x !== m.key)))} />
              <span>
                <b>{m.label}</b>
                {n > 0 && modules.includes(m.key) && <span className="pill edited" style={{ marginLeft: 6 }}>将覆盖 {n} 条已有配置</span>}
                <div className="hint">{m.desc}</div>
              </span>
            </label>
            {m.key === 'layers' && modules.includes('layers') && (
              <label className="inline small" style={{ marginLeft: 22, marginTop: 4 }}>
                <input type="checkbox" checked={styleOnly} onChange={(e) => setStyleOnly(e.target.checked)} />
                只套用样式，不改位置和时段
                <span className="hint" style={{ marginLeft: 4 }}>（按图层 id / 相同文字匹配；匹配不上的追加）</span>
              </label>
            )}
          </div>
        );
      })}
      {targets.length === 0 && <div className="error-text">请先在左侧勾选除当前视频以外的目标。</div>}
    </Modal>
  );
}

export function VideoList() {
  const videos = useEditor((s) => s.videos);
  const specs = useEditor((s) => s.specs);
  const currentId = useEditor((s) => s.currentVideoId);
  const selectedIds = useEditor((s) => s.selectedIds);
  const setCurrent = useEditor((s) => s.setCurrent);
  const toggleSelected = useEditor((s) => s.toggleSelected);
  const setSelectedAll = useEditor((s) => s.setSelectedAll);
  const [applyOpen, setApplyOpen] = useState(false);
  const allOn = videos.length > 0 && selectedIds.length === videos.length;

  return (
    <div className="col-left">
      <div className="vlist-head">
        <label className="inline">
          <input type="checkbox" checked={allOn} onChange={(e) => setSelectedAll(e.target.checked)} />
          全选
        </label>
        <span className="mono">{selectedIds.length} / {videos.length}</span>
      </div>
      <div className="vlist">
        {videos.map((v) => {
          const hasDraft = !!specs[v.id] && (specs[v.id].trim.remove.length > 0 || specs[v.id].layers.length > 0);
          return (
            <div key={v.id} className={`vrow ${v.id === currentId ? 'current' : ''}`} onClick={() => setCurrent(v.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setCurrent(v.id)}>
              <input type="checkbox" checked={selectedIds.includes(v.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelected(v.id)} aria-label={`选择 ${v.name}`} />
              <div className="poster" style={{ backgroundImage: v.poster_url ? `url("${v.poster_url}")` : undefined }} />
              <div>
                <div className="vname" title={v.name}>
                  {v.name}
                </div>
                <div className="vmeta">
                  <span className="mono">
                    {formatSeconds(v.duration)} · {v.width}×{v.height}
                  </span>
                  <span>
                    <Pill kind={videoPillKind(v, hasDraft)} />
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {videos.length === 0 && <div className="empty small">批次里还没有视频</div>}
      </div>
      <div className="vlist-foot">
        <button className="btn" disabled={selectedIds.filter((id) => id !== currentId).length === 0} onClick={() => setApplyOpen(true)}>
          批量应用当前配置 → 选中 {selectedIds.filter((id) => id !== currentId).length} 条
        </button>
      </div>
      {applyOpen && <ApplyDialog targetIds={selectedIds} onClose={() => setApplyOpen(false)} />}
    </div>
  );
}
