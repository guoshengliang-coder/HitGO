import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { useEditor } from '../store/editor';
import { player } from '../lib/player';
import { layerTypeForStep } from '../lib/steps';
import { frameDuration } from '../lib/time';
import { TopBar } from '../components/editor/TopBar';
import { ApplyDialog, VideoList } from '../components/editor/VideoList';
import { Stage } from '../components/editor/Stage';
import { QuickBar } from '../components/editor/QuickBar';
import { Transport } from '../components/editor/Transport';
import { Timeline } from '../components/editor/Timeline';
import { TrimPanel } from '../components/editor/TrimPanel';
import { AudioPanel } from '../components/editor/AudioPanel';
import { TextPanel } from '../components/editor/TextPanel';
import { StickerPanel } from '../components/editor/StickerPanel';
import { SubtitlePanel } from '../components/editor/SubtitlePanel';
import { LocalizePanel } from '../components/editor/LocalizePanel';
import { CropEditor } from '../components/editor/CropEditor';
import { ExportDialog } from '../components/editor/ExportDialog';
import { ProgressModal } from '../components/editor/ProgressModal';
import { ShortcutsModal } from '../components/editor/ShortcutsModal';
import { Splitter } from '../components/ui/Splitter';
import { clampPrefs, LAYOUT_DEFAULTS, loadLayoutPrefs, saveLayoutPrefs, type LayoutPrefs } from '../lib/layoutPrefs';

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * 快捷键统一入口。全部按 e.code 匹配（物理键位，不受输入法 / 大小写影响），优先级：
 * 输入框中 → 忽略；有弹窗 → 只留 Esc（各 Modal 自己处理）；修饰键组合；当前步骤单键；全局单键。
 */
function handleKey(e: KeyboardEvent) {
  if (isTyping(e)) return;
  const s = useEditor.getState();
  const mod = e.metaKey || e.ctrlKey;
  const frame = frameDuration(s.videos.find((v) => v.id === s.currentVideoId)?.fps);

  const modalOpen = s.progressOpen || s.shortcutsOpen || !!document.querySelector('.modal-backdrop');
  if (modalOpen) {
    // Esc 由 Modal 自己监听；快捷键表额外允许再按 ? 关闭
    if (s.shortcutsOpen && e.code === 'Slash' && e.shiftKey && !mod) {
      e.preventDefault();
      s.setShortcutsOpen(false);
    }
    return;
  }

  // ---- 修饰键组合 ----
  if (mod) {
    switch (e.code) {
      case 'KeyZ':
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      case 'KeyS':
        e.preventDefault();
        void s.flushSave().then(() => useEditor.getState().setToast('已保存'));
        return;
      case 'KeyC':
      case 'KeyV': {
        if (!layerTypeForStep(s.step)) return;
        // 页面上有选中文字时交给浏览器
        if (e.code === 'KeyC' && (window.getSelection()?.toString() ?? '') !== '') return;
        e.preventDefault();
        if (e.altKey) {
          if (e.code === 'KeyC') s.copyStyle();
          else s.pasteStyle();
        } else if (e.code === 'KeyC') s.copyLayer();
        else s.pasteLayer();
        return;
      }
      case 'KeyD':
        if (layerTypeForStep(s.step) && s.selectedLayerId) {
          e.preventDefault();
          s.duplicateLayer(s.selectedLayerId);
        }
        return;
      default:
        return; // 其他 ⌘ 组合交给浏览器
    }
  }

  if (e.altKey) {
    // ⌥ + 方向键：强制逐帧（文本 / 贴纸 / 字幕模块下方向键默认是微移）
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      player.seek(s.time + (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : frame));
    }
    return;
  }

  // ---- 当前步骤的单键 ----
  if (s.step === 'trim') {
    switch (e.code) {
      case 'KeyI':
        s.setInPoint(s.time);
        return;
      case 'KeyO':
        s.setOutPoint(s.time);
        return;
      case 'KeyQ':
        s.removeBefore();
        return;
      case 'KeyW':
        s.removeAfter();
        return;
      case 'Delete':
      case 'Backspace':
        if (s.selectedRangeIndex !== null) {
          e.preventDefault();
          s.deleteRemoveRange(s.selectedRangeIndex);
        }
        return;
      case 'Escape':
        s.setInPoint(null);
        s.setSelectedRange(null);
        return;
    }
  } else if (s.step === 'audio') {
    switch (e.code) {
      case 'Delete':
      case 'Backspace':
        if (s.selectedTrackId) {
          e.preventDefault();
          s.removeAudioTrack(s.selectedTrackId);
        }
        return;
      case 'Escape':
        s.setSelectedTrack(null);
        return;
    }
  } else if (layerTypeForStep(s.step)) {
    const layer = s.selectedLayerId ? s.currentSpec()?.layers.find((l) => l.id === s.selectedLayerId) ?? null : null;
    switch (e.code) {
      case 'Delete':
      case 'Backspace':
        if (layer) {
          e.preventDefault();
          s.removeLayer(layer.id);
        }
        return;
      case 'Escape':
        s.setSelectedLayer(null);
        return;
      case 'BracketLeft':
      case 'BracketRight': {
        if (!layer) return;
        e.preventDefault();
        const up = e.code === 'BracketRight';
        if (e.shiftKey) s.moveLayerTo(layer.id, up ? 'top' : 'bottom');
        else s.moveLayer(layer.id, up ? 1 : -1);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!layer || layer.locked) break; // 没有可动图层 → 落到全局的逐帧
        e.preventDefault();
        const k = e.shiftKey ? 10 : 1;
        const dx = e.code === 'ArrowLeft' ? -k : e.code === 'ArrowRight' ? k : 0;
        const dy = e.code === 'ArrowUp' ? -k : e.code === 'ArrowDown' ? k : 0;
        // 按住不放连续微移只记一次历史：首次按下记录，之后的 repeat 不记
        s.nudgeLayer(layer.id, dx, dy, !e.repeat);
        return;
      }
    }
  }

  // ---- 全局单键 ----
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      player.toggle();
      return;
    case 'ArrowLeft':
      e.preventDefault();
      player.seek(s.time - (e.shiftKey ? 1 : frame));
      return;
    case 'ArrowRight':
      e.preventDefault();
      player.seek(s.time + (e.shiftKey ? 1 : frame));
      return;
    case 'Slash':
      if (e.shiftKey) {
        e.preventDefault();
        s.setShortcutsOpen(!s.shortcutsOpen);
      }
      return;
    case 'KeyZ':
      if (e.shiftKey) {
        e.preventDefault();
        s.setTimelinePps(null);
      }
      return;
  }
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const load = useEditor((s) => s.load);
  const loading = useEditor((s) => s.loading);
  const error = useEditor((s) => s.error);
  const batch = useEditor((s) => s.batch);
  const step = useEditor((s) => s.step);
  const cropEditing = useEditor((s) => s.cropEditing);
  const currentVideoId = useEditor((s) => s.currentVideoId);
  const selectedIds = useEditor((s) => s.selectedIds);
  const progressOpen = useEditor((s) => s.progressOpen);
  const shortcutsOpen = useEditor((s) => s.shortcutsOpen);
  const toast = useEditor((s) => s.toast);
  const toastAction = useEditor((s) => s.toastAction);
  const setToast = useEditor((s) => s.setToast);
  const flushSave = useEditor((s) => s.flushSave);
  const [applyOpen, setApplyOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // 面板尺寸：右栏宽 / 时间线高，拖动分隔条调整，存本机
  const [layout, setLayout] = useState<LayoutPrefs>(() => loadLayoutPrefs());
  const resize = useCallback((patch: Partial<LayoutPrefs>) => {
    setLayout((cur) => {
      const next = clampPrefs({ ...cur, ...patch });
      saveLayoutPrefs(next);
      return next;
    });
  }, []);
  const layoutStyle = { '--right-w': `${layout.rightW}px`, '--timeline-h': `${layout.timelineH}px` } as CSSProperties;

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

  // 离开页面前把未保存的草稿写回
  useEffect(() => {
    return () => {
      void flushSave();
      player.pause();
    };
  }, [flushSave]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toastAction ? 6000 : 3500);
    return () => window.clearTimeout(t);
  }, [toast, toastAction, setToast]);

  // 快捷键
  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const applyTargets = selectedIds.filter((x) => x !== currentVideoId);

  if (error) {
    return (
      <div className="page">
        <div className="error-text">{error}</div>
      </div>
    );
  }
  // batch.id !== id：切批次时 load 的 effect 在首次 commit 之后才跑，不比对就会拿上一个
  // 批次的数据先画一帧（旧轨道、旧画面、旧批次名）——HIG-18
  if (loading || !batch || batch.id !== id) return <div className="empty">加载中…</div>;

  return (
    <div className="editor" style={layoutStyle}>
      <TopBar onExport={() => setExportOpen(true)} />
      <div className="editor-body">
        <VideoList />
        <div className="col-center">
          {/* 裁切编辑时 Stage 只隐藏不卸载：<video> 和 player 挂在 Stage 上，CropEditor 从它抓帧（HIG-5） */}
          {step === 'trim' && cropEditing && <CropEditor />}
          <Stage hidden={step === 'trim' && cropEditing} />
          <QuickBar />
          <Transport />
          <Splitter axis="y" label="调整时间线高度" onMove={(d) => resize({ timelineH: layout.timelineH - d })} onReset={() => resize({ timelineH: LAYOUT_DEFAULTS.timelineH })} />
          <Timeline />
        </div>
        <Splitter axis="x" label="调整右侧面板宽度" onMove={(d) => resize({ rightW: layout.rightW - d })} onReset={() => resize({ rightW: LAYOUT_DEFAULTS.rightW })} />
        <div className="col-right">
          {step === 'trim' && <TrimPanel />}
          {step === 'audio' && <AudioPanel onApply={() => setApplyOpen(true)} targetCount={applyTargets.length} />}
          {step === 'text' && <TextPanel onApply={() => setApplyOpen(true)} targetCount={applyTargets.length} />}
          {step === 'sticker' && <StickerPanel onApply={() => setApplyOpen(true)} targetCount={applyTargets.length} />}
          {step === 'subtitle' && <SubtitlePanel onApply={() => setApplyOpen(true)} targetCount={applyTargets.length} />}
          {step === 'localize' && <LocalizePanel />}
        </div>
      </div>
      {applyOpen && <ApplyDialog targetIds={selectedIds} defaultModules={step === 'audio' ? ['audio'] : step === 'localize' ? ['layers', 'audio'] : ['layers']} onClose={() => setApplyOpen(false)} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {progressOpen && <ProgressModal />}
      {shortcutsOpen && <ShortcutsModal />}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          {toastAction && (
            <button
              className="toast-action"
              onClick={() => {
                // 先关掉当前提示，再执行动作：动作自己弹出的提示（如「已撤销批量应用」）才不会被覆盖
                setToast(null);
                toastAction.run();
              }}
            >
              {toastAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
