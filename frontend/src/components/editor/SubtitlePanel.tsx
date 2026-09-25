// 「字幕」独立模块（HIG-15）：从文本面板迁出的本地字幕导入能力，加上遮住画面里原字幕的遮盖层。
// 每条字幕仍生成一个文字图层，因此沿用文字图层的画布、时间线、样式与批量应用语义。
// 遮盖层（契约 §2 type = "mask"）也归本模块管：新建时插到第一个文字图层之前，永远压在字幕之下。

import { useEffect, useRef, useState } from 'react';
import { useEditor, usePostDuration, usePostTime } from '../../store/editor';
import { defaultTextStyle, type MaskLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { BUILTIN_TEXT_PRESETS } from '../../lib/textPresets';
import { cuesToTextLayers, parseSrt } from '../../lib/srt';
import { newMaskLayer, timedTextSpan } from '../../lib/mask';
import { IconMask, IconText } from '../ui/Icons';
import { Section } from '../ui/Section';
import { LayerList, LayerProps, newTextLayer } from './LayerParts';
import { isSubtitleTextLayer } from '../../lib/layerSplit';
import { isAutoSubtitle } from '../../lib/autoSubtitle';

const IMPORT_HELP = '「自动识别字幕」听写原声里的人声（拼接的每段源视频各听写一次；上层视频轨的声音不识别），拆成短句按剪后时间轴生成字幕，再点会替换上一批自动字幕，手动添加和导入的不动。也可以导入 .srt 文件逐句生成带时段的字幕。都套用「黑底白字字幕条」样式，超出剪后时长的会被截掉；选中字幕后可在下方编辑内容、样式和位置。';
const MASK_HELP = '画面里烧死的原字幕先用一条遮盖糊掉或盖住，再叠新字幕。遮盖缺省贴底通栏，在画布上拖动、拉伸到原字幕的位置；它总在字幕之下。';

export function SubtitlePanel() {
  const addLayer = useEditor((s) => s.addLayer);
  const addLayers = useEditor((s) => s.addLayers);
  const updateLayer = useEditor((s) => s.updateLayer);
  const setToast = useEditor((s) => s.setToast);
  const postDuration = usePostDuration();
  const postTime = usePostTime();
  const focusLayer = useEditor((s) => s.focusLayer);
  const selectedSubtitle = useEditor((s) => {
    const l = s.currentVideoId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return isSubtitleTextLayer(l) ? l : null;
  });
  const addSubtitle = () => {
    const layer = newTextLayer(BUILTIN_TEXT_PRESETS.find((p) => p.id === 'builtin:subtitle-bar')?.style, '字幕');
    layer.origin = 'subtitle';
    const start = Math.min(Math.max(0, postTime), Math.max(0, postDuration - 0.1));
    layer.t = postDuration > 0.1 ? [start, Math.min(postDuration, start + 3)] : 'all';
    addLayer(layer);
    focusLayer(layer);
  };
  const subtitleSyncEnabled = useEditor((s) => s.subtitleSyncEnabled);
  const setSubtitleSyncEnabled = useEditor((s) => s.setSubtitleSyncEnabled);
  const inputRef = useRef<HTMLInputElement>(null);
  // 自动识别字幕（HIG-84）：复用改语言的听写，所以可用性和源语言列表都来自 /api/localize/options
  const localizeOptions = useEditor((s) => s.localizeOptions);
  const loadLocalizeOptions = useEditor((s) => s.loadLocalizeOptions);
  useEffect(() => { void loadLocalizeOptions(); }, [loadLocalizeOptions]);
  const autoSubtitles = useEditor((s) => s.autoSubtitles);
  const autoRunning = useEditor((s) => !!s.autoSubtitleVideoId);
  const autoCount = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.layers.filter(isAutoSubtitle).length ?? 0 : 0));
  const [autoLang, setAutoLang] = useState('auto');
  const autoDisabledReason = !localizeOptions ? '正在读取识别配置…' : !localizeOptions.enabled ? '服务器没有配置语音识别（DASHSCOPE_API_KEY），自动识别字幕不可用' : null;
  const runAutoSubtitles = () => {
    if (autoCount && !window.confirm(`重新识别会替换上一批 ${autoCount} 条自动字幕（手动添加和 .srt 导入的保留），继续？`)) return;
    void autoSubtitles({ sourceLang: autoLang });
  };
  const selectedMask = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return l?.type === 'mask' ? (l as MaskLayer) : null;
  });
  // 「按字幕时段」：把选中遮盖的显示时段收到所有带时段字幕的首尾
  const subtitleSpan = useEditor((s) => (s.currentVideoId ? timedTextSpan(s.specs[s.currentVideoId]?.layers ?? []) : null));

  const importSrt = async (file: File) => {
    let text = '';
    try {
      text = await file.text();
    } catch {
      setToast('读取字幕文件失败');
      return;
    }
    const cues = parseSrt(text);
    const preset = BUILTIN_TEXT_PRESETS.find((p) => p.id === 'builtin:subtitle-bar');
    const style = { ...defaultTextStyle(), ...(preset?.style ?? {}) };
    const layers = cuesToTextLayers(cues, { style, newId: newLayerId, maxEnd: postDuration > 0 ? postDuration : undefined });
    layers.forEach((layer) => { layer.origin = 'subtitle'; });
    if (!layers.length) {
      setToast('没有解析到字幕');
      return;
    }
    addLayers(layers);
    setToast(`已导入 ${layers.length} 条字幕`);
  };

  const fitToSubtitles = () => {
    if (!selectedMask || !subtitleSpan) return;
    const [a, b] = subtitleSpan;
    updateLayer(selectedMask.id, { t: [Math.round(a * 100) / 100, Math.round(b * 100) / 100] });
  };

  return (
    <div className="panel">
      <div className="panel-head">字幕</div>
      <div className="panel-body inspector">
        <Section id="subtitle.import" title="识别 / 添加 / 导入字幕" bodyClass="stack" hint="支持逐句编辑" help={IMPORT_HELP}>
          <div className="inline">
            <button
              className="btn action"
              disabled={autoRunning || !!autoDisabledReason}
              title={autoDisabledReason ?? (autoCount ? `重新识别并替换上一批 ${autoCount} 条自动字幕；手动添加和 .srt 导入的保留` : '听写原声里的人声，拆成短句自动生成字幕（后台任务）')}
              onClick={runAutoSubtitles}
            >
              <IconText /> {autoRunning ? '识别中…' : autoCount ? '重新识别字幕' : '自动识别字幕'}
            </button>
            <select className="select sm" value={autoLang} disabled={autoRunning || !!autoDisabledReason} onChange={(e) => setAutoLang(e.target.value)} aria-label="识别语言" title="原声的语言；自动 = 让模型判断">
              <option value="auto">自动</option>
              {localizeOptions?.source_langs.filter((l) => l.code !== 'auto').map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </div>
          <div className="inline">
            <button className="btn action" onClick={addSubtitle}><IconText /> 添加字幕</button>
            <button className="btn action" onClick={() => inputRef.current?.click()}>
              <IconText /> 选择 .srt 文件
            </button>
          </div>
        </Section>
        <input
          ref={inputRef}
          type="file"
          accept=".srt,.vtt,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // 允许重复导入同一个文件
            if (file) void importSrt(file);
          }}
        />

        <LayerList type="text" lane="subtitle" emptyHint="还没有字幕。自动识别、添加字幕或导入 .srt 文件，也可以在「改语言」中生成字幕。" />
        <label className="inline"><input type="checkbox" checked={subtitleSyncEnabled} onChange={(e) => setSubtitleSyncEnabled(e.target.checked)} />同步修改当前视频所有字幕的样式和位置（开启时统一为选中字幕的字号）</label>
        {selectedSubtitle && <LayerProps key={selectedSubtitle.id} layer={selectedSubtitle} />}

        <Section id="subtitle.mask" title="遮盖原字幕" bodyClass="stack" hint="在画布上拖到原字幕的位置" help={MASK_HELP}>
          <div className="inline">
            <button className="btn action" onClick={() => addLayer(newMaskLayer(newLayerId), { belowType: 'text' })}>
              <IconMask /> 添加遮盖
            </button>
            <button
              className="btn ghost sm"
              disabled={!selectedMask || !subtitleSpan}
              title={!selectedMask ? '先选中一条遮盖' : !subtitleSpan ? '还没有带时段的字幕' : `把遮盖的显示时段设为 ${subtitleSpan[0].toFixed(1)}s – ${subtitleSpan[1].toFixed(1)}s`}
              onClick={fitToSubtitles}
            >
              按字幕时段
            </button>
          </div>
        </Section>
        <LayerList type="mask" emptyHint="还没有遮盖。点「添加遮盖」，在画布上把它拖到原字幕的位置；模糊 / 色块与强度在属性里改。" />
        {selectedMask && <LayerProps key={selectedMask.id} layer={selectedMask} />}
      </div>
    </div>
  );
}
