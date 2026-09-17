// 「新建素材」（HIG-50）：一个按钮带两项菜单——上传视频 / 图片（同一个文件选择框），或建一条空白素材。
// 空白素材的表单字段独立成 BlankMaterialFields，批次列表页的新建表单也用它（那边没有批次，先建批次再建素材）。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { VIDEO_ACCEPT, VIDEO_ACCEPT_LABEL } from '../../lib/fileDrop';
import type { AspectKey, BlankVideoIn } from '../../types';
import { IconPlus } from './Icons';
import { Modal } from './Modal';

/** 空白素材表单的值；提交时转成 BlankVideoIn（空名称不发，让后端起缺省名）。 */
export interface BlankDraft {
  name: string;
  color: string;
  duration: number;
  aspect: AspectKey;
}

export const BLANK_DEFAULTS: BlankDraft = { name: '', color: '#000000', duration: 10, aspect: '9:16' };
/** 时长范围（秒），与契约 §3 一致。 */
export const BLANK_DURATION_MIN = 0.5;
export const BLANK_DURATION_MAX = 600;

const ASPECTS: { v: AspectKey; label: string }[] = [
  { v: '9:16', label: '9:16 竖版' },
  { v: '1:1', label: '1:1 方形' },
  { v: '4:5', label: '4:5' },
  { v: '16:9', label: '16:9 横版' },
];

export function blankDraftValid(d: BlankDraft): boolean {
  return Number.isFinite(d.duration) && d.duration >= BLANK_DURATION_MIN && d.duration <= BLANK_DURATION_MAX && /^#[0-9a-f]{6}$/i.test(d.color);
}

export function blankDraftToBody(d: BlankDraft): BlankVideoIn {
  const name = d.name.trim();
  return { ...(name ? { name } : {}), color: d.color, duration: d.duration, aspect: d.aspect };
}

/** 名称 / 颜色 / 时长 / 画幅四个字段，横排自动换行。 */
export function BlankMaterialFields({ value, onChange, disabled }: { value: BlankDraft; onChange: (next: BlankDraft) => void; disabled?: boolean }) {
  const set = (patch: Partial<BlankDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="form-row blank-fields">
      <label className="field" style={{ flex: 1, minWidth: 140 }}>
        名称（可不填）
        <input className="input" value={value.name} maxLength={80} placeholder="空白素材" disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="field">
        颜色
        <input className="input blank-color" type="color" value={value.color} disabled={disabled} aria-label="背景颜色" onChange={(e) => set({ color: e.target.value })} />
      </label>
      <label className="field">
        时长（秒）
        <input className="input num" type="number" min={BLANK_DURATION_MIN} max={BLANK_DURATION_MAX} step={0.5} value={value.duration} disabled={disabled} onChange={(e) => set({ duration: parseFloat(e.target.value) })} />
      </label>
      <label className="field">
        画幅
        <select className="select" value={value.aspect} disabled={disabled} aria-label="画幅" onChange={(e) => set({ aspect: e.target.value as AspectKey })}>
          {ASPECTS.map((a) => (
            <option key={a.v} value={a.v}>{a.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** 编辑器左栏的「空白素材…」弹窗：提交交给调用方（建素材 + 刷新列表）。 */
export function BlankMaterialDialog({ onSubmit, onClose }: { onSubmit: (body: BlankVideoIn) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<BlankDraft>(BLANK_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!blankDraftValid(draft)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(blankDraftToBody(draft));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="新建空白素材"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" disabled={busy || !blankDraftValid(draft)} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-col">
        <div className="hint">一段纯色画面，当大字报 / 文字动画的底；建好后和上传的视频一样可以加图层、批量应用、导出。</div>
        <BlankMaterialFields value={draft} onChange={setDraft} disabled={busy} />
        {!blankDraftValid(draft) && <div className="error-text">时长要在 {BLANK_DURATION_MIN}–{BLANK_DURATION_MAX} 秒之间。</div>}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

/**
 * 「新建素材」按钮 + 两项菜单。菜单点外面 / Esc 关闭；up 为真时菜单往上弹（按钮贴在栏底时用）。
 * 文件选择框藏在这里：选完就把 File[] 交给 onFiles，input 清空以便再选同一批。
 */
export function NewMaterialButton({ onFiles, onBlank, disabled, up, className, children }: { onFiles: (files: File[]) => void; onBlank: () => void; disabled?: boolean; up?: boolean; className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={wrapRef} className={`menu-wrap ${className ?? ''}`}>
      <button className="btn" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {children ?? (
          <>
            <IconPlus /> 新建素材
          </>
        )}
      </button>
      {open && (
        <div className={`menu ${up ? 'up' : ''}`} role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); fileRef.current?.click(); }}>
            上传视频 / 图片
            <span className="muted small">{VIDEO_ACCEPT_LABEL}</span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); onBlank(); }}>
            空白素材…
            <span className="muted small">纯色画面，当文字的底</span>
          </button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={VIDEO_ACCEPT}
        hidden
        aria-label="上传视频 / 图片"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </span>
  );
}
