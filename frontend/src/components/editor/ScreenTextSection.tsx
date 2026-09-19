// 「画面文字」分组（HIG-38）：识别画面上烧死的文字 → 擦成无字版 → 把译文写回原位。
// 挂在「改语言」面板下面——它是改语言的另一半：那边换声音，这边换画面上的字。
// 状态全在 video.screen_text 上，后台任务由 store 轮询；这里只管展示、发请求和逐块勾选。
//
// 逐块精修不在这里：生成出来的就是普通文字图层，拖位置、调字号颜色、拖宽度、自动换行、分段
// 全部是「文本」模块现成的能力，这里再做一遍只会有两套不一致的编辑入口。

import { useState } from 'react';
import { useEditor } from '../../store/editor';
import { player } from '../../lib/player';
import { formatTime } from '../../lib/time';
import { langLabel } from '../../lib/localize';
import { cleanReady, mergedBlocks, screenTextActive, STYLE_CONFIDENCE_HINT } from '../../lib/screentext';
import { Section } from '../ui/Section';
import { Field } from '../ui/Num';
import type { LocalizeOptions, ScreenBlock, ScreenText, Video } from '../../types';

const DETECT_HELP =
  '识别画面上烧死的文字：硬字幕、标题、角标、价格牌。按场景变化抽帧送给视觉模型，静止画面的重复帧会先丢掉，' +
  '所以一条几十秒的视频通常只花十来次调用。识别结果可以逐条改文字、关掉不想处理的块。';
const ERASE_HELP =
  '把识别到的文字从画面上擦掉，生成一条「无字版」源片；原片永远保留，随时切回。' +
  '硬字幕带整条视频全程擦——比按句时段擦便宜，也不会因为时段差半帧而漏擦。' +
  '擦完之后套用改语言，译文会直接落在干净的画面上，不再需要遮盖。';
const WRITE_HELP =
  '译文会在原位置生成可编辑的文字图层：字号、颜色、对齐、出现时间都按画面估出来，' +
  '但字体识别做不到，一律用该语言的默认字体。估出来的只是起点，拖一拖调成想要的样子，' +
  '下次重新套用会按块接回你调过的结果。';

function statusText(status: string | undefined, error?: string | null): string {
  if (status === 'queued') return '排队中…';
  if (status === 'running') return '处理中…';
  if (status === 'failed') return `失败：${error ?? '未知原因'}`;
  if (status === 'done') return '已完成';
  return '未开始';
}

function BlockRow({ block, translated, onToggle, onRename }: { block: ScreenBlock; translated: string; onToggle: (on: boolean) => void; onRename: (text: string) => void }) {
  const [draft, setDraft] = useState(block.text);
  const unsure = (block.style?.confidence ?? 1) < STYLE_CONFIDENCE_HINT;
  return (
    <div className={`st-block ${block.enabled === false ? 'off' : ''}`}>
      <label className="st-block-head">
        <input type="checkbox" checked={block.enabled !== false} disabled={block.moving} onChange={(e) => onToggle(e.target.checked)} />
        <button type="button" className="linklike small" onClick={() => player.seek(block.t[0])} title="跳到这块文字出现的时间">
          {formatTime(block.t[0])}–{formatTime(block.t[1])}
        </button>
        {block.moving && <span className="badge-stale" title="会动、带透视或带动画的文字不在处理范围内，需要手动处理">会动 · 不处理</span>}
        {unsure && !block.moving && <span className="badge-stale" title="样式是从画面估出来的，这一块把握不高，写回之后请核对字号和颜色">样式请核对</span>}
      </label>
      <input
        className="st-block-text"
        value={draft}
        disabled={block.moving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== block.text && onRename(draft)}
        title="识别出来的原文；改对了译文才会对"
      />
      {translated && <div className="st-block-translated small muted">{translated}</div>}
    </div>
  );
}

export function ScreenTextSection({ video, options, langs }: { video: Video; options: LocalizeOptions | null; langs: string[] }) {
  const screen: ScreenText | null | undefined = video.screen_text;
  const stOptions = useEditor((s) => s.screenTextOptions);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const runScreenText = useEditor((s) => s.runScreenText);
  const updateScreenBlocks = useEditor((s) => s.updateScreenBlocks);
  const deleteScreenErase = useEditor((s) => s.deleteScreenErase);
  const setSourceVariant = useEditor((s) => s.setSourceVariant);

  const active = screenTextActive(screen);
  const detect = screen?.detect;
  const detected = detect?.status === 'done';
  const blocked = !stOptions?.enabled || video.status !== 'ready' || active;
  const tooLong = !!stOptions?.max_seconds && video.duration > stOptions.max_seconds;
  const usingClean = spec?.source_variant === 'clean';

  // 译文对照用第一个目标语言；没选语言时只看原文。
  const lang = langs[0] ?? '';
  const blocks = mergedBlocks(detect, lang ? screen?.versions?.[lang] : null);
  const usable = blocks.filter((b) => !b.moving && b.enabled !== false);

  const summary = !detect ? '未识别' : detect.status !== 'done' ? statusText(detect.status, detect.error) : `${blocks.length} 处画面文字${detect.subtitle_band ? ' · 含硬字幕带' : ''}`;

  return (
    <Section id="localize.screenText" title="画面文字" bodyClass="stack" summary={<span>{summary}</span>} help={DETECT_HELP} defaultOpen={false}>
      {!stOptions?.enabled && <div className="error-text">服务器没有配置百炼 API Key（DASHSCOPE_API_KEY），画面文字识别不可用。</div>}
      {tooLong && <div className="error-text">源视频超过 {stOptions?.max_seconds} 秒，暂不支持画面文字处理。</div>}

      <Field label="识别">
        <span className="small">{statusText(detect?.status, detect?.error)}</span>
        {detected && !!detect?.frames && <span className="small muted">送去识别 {detect.frames} 帧</span>}
        <button className="btn" disabled={blocked || tooLong} onClick={() => runScreenText({ detect: true, target_langs: langs })} title={detected ? '重新识别一遍；已有的译文会被标为需要重译' : '识别画面上烧死的文字'}>
          {detected ? '重新识别' : '识别画面文字'}
        </button>
      </Field>

      {detected && blocks.length === 0 && <div className="hint">这条视频没有识别到烧在画面上的文字，不需要处理。</div>}

      {detected && blocks.length > 0 && (
        <>
          {detect?.subtitle_band && (
            <div className="hint">
              识别到一条硬字幕带。它的内容就是口播，所以不单独翻译——擦掉之后，套用改语言时译文字幕会直接落在原字幕的位置和样式上。
            </div>
          )}
          <div className="st-blocks">
            {blocks.map((b) => (
              <BlockRow
                key={b.id}
                block={b}
                translated={b.translated}
                onToggle={(on) => updateScreenBlocks([{ id: b.id, enabled: on }])}
                onRename={(text) => updateScreenBlocks([{ id: b.id, text }])}
              />
            ))}
          </div>

          <Field label="翻译" title={WRITE_HELP}>
            <span className="small muted">{lang ? `按上方勾选的${langLabel(options, lang)}` : '先在上方勾一个目标语言'}</span>
            <button className="btn" disabled={blocked || !lang || !usable.length} onClick={() => runScreenText({ target_langs: langs })} title="把这些画面文字翻译成勾选的语言；套用时会写回原位置">
              翻译画面文字
            </button>
          </Field>

          <Field label="擦除" title={ERASE_HELP}>
            <span className="small">{statusText(screen?.erase?.status, screen?.erase?.error)}</span>
            {screen?.erase?.stale && <span className="badge-stale">识别结果改过，建议重擦</span>}
            <button className="btn" disabled={blocked || !stOptions?.erase_enabled} onClick={() => runScreenText({ erase: true, target_langs: langs })} title="把原文字从画面上擦掉，生成无字版源片；原片保留">
              {screen?.erase?.status === 'done' ? '重新擦除' : '擦除原文字'}
            </button>
            {screen?.erase?.status === 'done' && (
              <button className="btn" disabled={active} onClick={() => deleteScreenErase()} title="删掉无字版文件并切回原片">
                删除无字版
              </button>
            )}
          </Field>

          {cleanReady(screen) && (
            <Field label="正片用">
              <div className="seg">
                <button className={`btn ${!usingClean ? 'on' : ''}`} onClick={() => setSourceVariant('original')}>
                  原片
                </button>
                <button className={`btn ${usingClean ? 'on' : ''}`} onClick={() => setSourceVariant('clean')} title="预览和成片都用擦掉文字的无字版；原片随时可以切回来">
                  无字版
                </button>
              </div>
            </Field>
          )}
        </>
      )}
    </Section>
  );
}
