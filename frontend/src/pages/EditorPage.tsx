import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { useEditor } from '../store/editor';
import { player } from '../lib/player';
import { layerTypeForStep } from '../lib/steps';
import { frameDuration, postToSource, sourceToPost } from '../lib/time';
import { SOURCE_TRACK_ID } from '../lib/audioTracks';
import { adjacentCutPoint, cutPoints, nextShuttleRate, TIMELINE_ZOOM_EVENT } from '../lib/transportKeys';
import { TopBar } from '../components/editor/TopBar';
import { VideoList } from '../components/editor/VideoList';
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
 * ↑ / ↓ 跳剪辑点的目标（源时间）。剪辑模块的时间轴是源时间轴，删除区间两端都是可见的点；
 * 其它模块按剪后时间轴算（删掉的区间两端在剪后是同一点，不去重会按一下没反应）。
 * 剪辑点：删除区间两端、入点、非全程图层的时段两端，加上开头与片尾。
 */
function cutPointTarget(dir: 1 | -1): number | null {
  const s = useEditor.getState();
  const spec = s.currentSpec();
  const duration = player.duration || s.videos.find((v) => v.id === s.currentVideoId)?.duration || 0;
  const remove = spec?.trim.remove ?? [];
  const now = Math.max(0, player.currentTime);
  const layerEdges = (spec?.layers ?? []).flatMap((l) => (l.t === 'all' ? [] : l.t));
  if (s.step === 'trim') {
    const pts = cutPoints(duration, remove, [...(s.inPoint !== null ? [s.inPoint] : []), ...layerEdges.map((x) => postToSource(x, remove))]);
    return adjacentCutPoint(pts, now, dir);
  }
  const postDuration = sourceToPost(duration, remove);
  const pts = cutPoints(postDuration, [], [...remove.flat().map((x) => sourceToPost(x, remove)), ...layerEdges]);
  const t = adjacentCutPoint(pts, sourceToPost(now, remove), dir);
  return t === null ? null : postToSource(t, remove);
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void document.querySelector<HTMLElement>('.stage-wrap')?.requestFullscreen().catch(() => undefined);
}

interface KeyActions {
  openExport: () => void;
}

/**
 * 快捷键统一入口（键位对齐剪映专业版，HIG-30）。全部按 e.code 匹配（物理键位，不受输入法 / 大小写影响），优先级：
 * 输入框中 → 忽略；有弹窗 → 只留 Esc（各 Modal 自己处理）；修饰键组合；⌥ + 方向键微移；当前步骤单键；全局单键。
 */
function handleKey(e: KeyboardEvent, actions: KeyActions) {
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

  const layerStep = !!layerTypeForStep(s.step);

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
      case 'KeyE':
        e.preventDefault();
        actions.openExport();
        return;
      case 'KeyF':
        if (!e.shiftKey) return; // ⌘F 留给浏览器查找
        e.preventDefault();
        toggleFullscreen();
        return;
      case 'Equal':
      case 'NumpadAdd':
      case 'Minus':
      case 'NumpadSubtract':
        e.preventDefault(); // 不让浏览器缩放页面
        window.dispatchEvent(new CustomEvent(TIMELINE_ZOOM_EVENT, { detail: e.code === 'Equal' || e.code === 'NumpadAdd' ? 1 : -1 }));
        return;
      case 'KeyC':
      case 'KeyV':
      case 'KeyX': {
        if (!layerStep) return;
        // 页面上有选中文字时交给浏览器
        if (e.code !== 'KeyV' && (window.getSelection()?.toString() ?? '') !== '') return;
        e.preventDefault();
        if (e.altKey) {
          if (e.code === 'KeyC') s.copyStyle();
          else if (e.code === 'KeyV') s.pasteStyle();
        } else if (e.code === 'KeyC') s.copyLayer();
        else if (e.code === 'KeyV') s.pasteLayer();
        else if (s.selectedLayerId) {
          // 剪切 = 复制 + 删除
          s.copyLayer();
          s.removeLayer(s.selectedLayerId);
          useEditor.getState().setToast('已剪切图层');
        }
        return;
      }
      case 'KeyB':
        // 剪映的分割 ⌘B：目前只有音轨能拆分（音频模块选中的 BGM / 口播 / 分离轨，HIG-25）
        if (s.step === 'audio' && s.selectedTrackId && s.selectedTrackId !== SOURCE_TRACK_ID) {
          e.preventDefault();
          s.splitAudioTrack(s.selectedTrackId);
        }
        return;
      case 'KeyD':
        if (layerStep && s.selectedLayerId) {
          e.preventDefault();
          s.duplicateLayer(s.selectedLayerId);
        }
        return;
      default:
        return; // 其他 ⌘ 组合交给浏览器
    }
  }

  if (e.altKey) {
    // ⌥ + 方向键：微移选中图层（⇧ 10 px）。剪映里方向键是逐帧 / 跳剪辑点，微移挪到 ⌥ 上。
    if (!layerStep || !e.code.startsWith('Arrow')) return;
    const layer = s.selectedLayerId ? s.currentSpec()?.layers.find((l) => l.id === s.selectedLayerId) ?? null : null;
    if (!layer || layer.locked) return;
    e.preventDefault();
    const k = e.shiftKey ? 10 : 1;
    const dx = e.code === 'ArrowLeft' ? -k : e.code === 'ArrowRight' ? k : 0;
    const dy = e.code === 'ArrowUp' ? -k : e.code === 'ArrowDown' ? k : 0;
    // 按住不放连续微移只记一次历史：首次按下记录，之后的 repeat 不记
    s.nudgeLayer(layer.id, dx, dy, !e.repeat);
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
    const onSource = s.selectedTrackId === SOURCE_TRACK_ID;
    switch (e.code) {
      case 'KeyS':
        if (s.selectedTrackId && !onSource) s.splitAudioTrack(s.selectedTrackId);
        return;
      case 'KeyQ':
        if (s.selectedTrackId) s.cutTrackBefore(s.selectedTrackId);
        return;
      case 'KeyW':
        if (s.selectedTrackId) s.cutTrackAfter(s.selectedTrackId);
        return;
      case 'KeyI':
        // 原声静音区间的入点 / 出点：存源时间，出点时换算成剪后时间（同剪辑模块的 I / O）
        s.setSelectedTrack(SOURCE_TRACK_ID);
        s.setInPoint(s.time);
        return;
      case 'KeyO': {
        const spec = s.currentSpec();
        if (s.inPoint === null || !spec) {
          s.setSelectedTrack(SOURCE_TRACK_ID);
          s.setInPoint(s.time);
          return;
        }
        const remove = spec.trim.remove;
        s.addSourceMute(sourceToPost(s.inPoint, remove), sourceToPost(Math.max(0, s.time), remove));
        s.setInPoint(null);
        return;
      }
      case 'Delete':
      case 'Backspace':
        if (onSource) {
          if (s.selectedMuteIndex !== null) {
            e.preventDefault();
            s.deleteSourceMute(s.selectedMuteIndex);
          }
        } else if (s.selectedTrackId) {
          e.preventDefault();
          s.removeAudioTrack(s.selectedTrackId);
        }
        return;
      case 'Escape':
        s.setInPoint(null);
        s.setSelectedMute(null);
        s.setSelectedTrack(null);
        return;
    }
  } else if (layerStep) {
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
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      const t = cutPointTarget(e.code === 'ArrowUp' ? -1 : 1);
      if (t !== null) player.seek(t);
      return;
    }
    case 'KeyJ':
    case 'KeyK':
    case 'KeyL': {
      e.preventDefault();
      const cur = player.isPlaying ? player.rate : 0;
      player.shuttle(nextShuttleRate(cur, e.code === 'KeyJ' ? 'J' : e.code === 'KeyK' ? 'K' : 'L'));
      return;
    }
    case 'KeyN':
      e.preventDefault();
      s.toggleSnap();
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
  const progressOpen = useEditor((s) => s.progressOpen);
  const shortcutsOpen = useEditor((s) => s.shortcutsOpen);
  const toast = useEditor((s) => s.toast);
  const toastAction = useEditor((s) => s.toastAction);
  const setToast = useEditor((s) => s.setToast);
  const flushSave = useEditor((s) => s.flushSave);
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
    const onKey = (e: KeyboardEvent) => handleKey(e, { openExport: () => setExportOpen(true) });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          {step === 'audio' && <AudioPanel />}
          {step === 'text' && <TextPanel />}
          {step === 'sticker' && <StickerPanel />}
          {step === 'subtitle' && <SubtitlePanel />}
          {step === 'localize' && <LocalizePanel />}
        </div>
      </div>
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
