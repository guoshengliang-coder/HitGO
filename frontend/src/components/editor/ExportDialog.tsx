// 右上角「导出」弹窗（HIG-8）：选范围后保存并提交渲染。默认导出这一批。
// 勾选画幅（HIG-29）：每条视频按勾选的画幅各出一个文件；各画幅的填充 / 裁切在剪辑模块「成片画面」里按页签设置。
// 勾选跟着当前视频的 spec 走（HIG-35，outputs[].export），和「成片画面」页签上的勾是同一份；
// 本机旧记录只在没有当前视频时兜底，不能覆盖当前视频的选择。
// 可选填一个导出名称（HIG-27），写到这次的每个任务上：产物页能按它搜，下载的文件名也用它。
// 勾选语言（HIG-43）：范围内有改语言生成好的版本时出现，每条视频 × 勾选语言 × 勾选画幅各出一个文件；缺某语言的视频跳过并列出。

import { useMemo, useState } from 'react';
import { useEditor, type ExportDialogRequest } from '../../store/editor';
import { defaultExportScope, dialogExportKeys, loadExportVariants, resolveExportTargets, toggleExportVariant, type ExportScope } from '../../lib/exportScope';
import { exportableLangs, ORIGINAL_LANG, planLanguageExport } from '../../lib/langExport';
import { langLabel } from '../../lib/localize';
import { VARIANT_DEFS, outputSize, type VariantKey } from '../../types';
import { Modal } from '../ui/Modal';

export function ExportDialog({ request, onClose }: { request?: ExportDialogRequest; onClose: () => void }) {
  const videos = useEditor((s) => s.videos);
  const selectedIds = useEditor((s) => s.selectedIds);
  const currentId = useEditor((s) => s.currentVideoId);
  const rendering = useEditor((s) => s.rendering);
  const saveAndRender = useEditor((s) => s.saveAndRender);
  const currentSpec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const previewKey = useEditor((s) => s.previewVariantKey);
  const [scope, setScope] = useState<ExportScope>(request?.scope ?? defaultExportScope(currentSpec));
  const assets = useEditor((s) => s.assets);
  const localizeOptions = useEditor((s) => s.localizeOptions);
  const [langs, setLangs] = useState<string[]>(request?.langs ?? []);
  const batchName = useEditor((s) => s.batch?.name ?? '');
  const [name, setName] = useState('');
  const setExportVariants = useEditor((s) => s.setExportVariants);
  const [fallbackKeys, setFallbackKeys] = useState<VariantKey[]>(() => loadExportVariants());
  const variantKeys = dialogExportKeys(currentSpec, fallbackKeys);
  const toggleVariant = (key: VariantKey) => {
    const next = toggleExportVariant(variantKeys, key);
    // 有当前视频就写回它的 spec（和「成片画面」页签同一份）；没有时只在弹窗里生效
    if (currentSpec) setExportVariants(next);
    else setFallbackKeys(next);
  };

  const current = videos.find((v) => v.id === currentId);
  const selectedCount = videos.filter((v) => selectedIds.includes(v.id)).length;
  const targets = useMemo(() => resolveExportTargets(videos, scope, selectedIds, currentId), [videos, scope, selectedIds, currentId]);
  const targetVideos = useMemo(() => videos.filter((v) => targets.ids.includes(v.id)), [videos, targets.ids]);
  const langChoices = useMemo(() => exportableLangs(targetVideos, assets), [targetVideos, assets]);
  // 只算范围内还能出的语言：换范围后之前勾的语言可能没有了
  const activeLangs = langs.filter((l) => l === ORIGINAL_LANG || langChoices.includes(l));
  const langPlan = activeLangs.length ? planLanguageExport(targetVideos, activeLangs, assets) : null;
  const fileCount = (langPlan ? langPlan.items.length : targets.ids.length) * variantKeys.length;
  const toggleLang = (lang: string) => setLangs((cur) => (cur.includes(lang) ? cur.filter((l) => l !== lang) : [...cur, lang]));
  const label = (lang: string) => (lang === ORIGINAL_LANG ? '原版' : langLabel(localizeOptions, lang));

  const options: { key: ExportScope; label: string; note: string; disabled?: boolean }[] = [
    { key: 'batch', label: '这一批全部', note: `${videos.length} 条` },
    { key: 'selected', label: '左侧勾选的', note: selectedCount ? `${selectedCount} 条` : '还没有勾选', disabled: selectedCount === 0 },
    { key: 'current', label: '仅当前这条', note: current?.name ?? '—', disabled: !current },
  ];

  return (
    <Modal
      title="导出"
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={rendering || targets.ids.length === 0 || (!!langPlan && langPlan.items.length === 0)}
            onClick={() => {
              void saveAndRender(targets.ids, { name, variantKeys, langs: activeLangs });
              onClose();
            }}
          >
            {!targets.ids.length
              ? '没有可导出的视频'
              : langPlan
                ? langPlan.items.length
                  ? `导出 ${fileCount} 个文件`
                  : '勾选的语言都没有可导出的版本'
                : `导出 ${targets.ids.length} 条${variantKeys.length > 1 ? ` × ${variantKeys.length} 个画幅` : ''}`}
          </button>
        </>
      }
    >
      <label className="field" style={{ marginBottom: 12 }}>
        导出名称（可选）
        <input
          className="input"
          value={name}
          maxLength={120}
          placeholder={`例如：${batchName ? `${batchName} ` : ''}${exportDateLabel()} 版`}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="hint">产物页可按名称搜索；下载的文件名为「名称_视频名_画幅.mp4」（多语言时为「名称_视频名_语言_画幅.mp4」），不填时用批次名。</span>
      </label>
      <div className="field" style={{ marginBottom: 12 }}>
        画幅
        <div className="chips export-variants" role="group" aria-label="导出画幅">
          {VARIANT_DEFS.map((d) => {
            const on = variantKeys.includes(d.key);
            const configured = currentSpec?.outputs.find((o) => o.variant_key === d.key);
            const dimensions = configured ? outputSize(configured) : d;
            return (
              <button key={d.key} type="button" role="checkbox" aria-checked={on} className={`chip export-variant ${on ? 'active' : ''}`} title={d.note} onClick={() => toggleVariant(d.key)}>
                {d.label}
                <span className="mono small muted">{dimensions.width}×{dimensions.height}</span>
              </button>
            );
          })}
        </div>
        {variantKeys.length > 1 && <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => {
          const only = variantKeys.includes(previewKey) ? previewKey : variantKeys[0];
          if (currentSpec) setExportVariants([only]);
          else setFallbackKeys([only]);
        }}>仅保留 {VARIANT_DEFS.find((d) => d.key === (variantKeys.includes(previewKey) ? previewKey : variantKeys[0]))?.label} 画幅</button>}
        <span className="hint">每条视频按勾选的画幅各出一个文件（共 {fileCount} 个）。勾选随当前视频保存，和剪辑模块「成片画面」页签上的勾同步。非 9:16 画幅上文字、贴纸、遮盖默认跟着视频画面走。</span>
      </div>
      {langChoices.length > 0 && (
        <div className="field" style={{ marginBottom: 12 }}>
          语言
          <div className="chips export-langs" role="group" aria-label="导出语言">
            {[ORIGINAL_LANG, ...langChoices].map((lang) => {
              const on = activeLangs.includes(lang);
              return (
                <button key={lang} type="button" role="checkbox" aria-checked={on} className={`chip export-lang ${on ? 'active' : ''}`} title={lang === ORIGINAL_LANG ? '不带改语言配音 / 译文字幕的原片' : `${label(lang)}配音 + ${label(lang)}字幕`} onClick={() => toggleLang(lang)}>
                  {label(lang)}
                </button>
              );
            })}
          </div>
          <span className="hint">
            {activeLangs.length
              ? `每条视频按勾选的语言各套用一次再出片（${activeLangs.map(label).join('、')}），编辑器里当前的套用不变。`
              : '不勾语言 = 按每条视频当前的样子导出；勾了就每个语言各出一份（改语言生成好的版本）。'}
          </span>
          {langPlan && langPlan.skipped.length > 0 && (
            <div className="hint export-lang-skipped">
              将跳过 {langPlan.skipped.length} 个组合：
              {langPlan.skipped
                .slice(0, 6)
                .map((sk) => `${sk.video_name} · ${label(sk.lang)}`)
                .join('；')}
              {langPlan.skipped.length > 6 ? ` 等` : ''}
            </div>
          )}
        </div>
      )}
      <div className="scope-list" role="radiogroup" aria-label="导出范围">
        {options.map((o) => (
          <label key={o.key} className={`scope-option ${scope === o.key ? 'active' : ''} ${o.disabled ? 'disabled' : ''}`}>
            <input type="radio" name="export-scope" checked={scope === o.key} disabled={o.disabled} onChange={() => setScope(o.key)} />
            <b>{o.label}</b>
            <span className="muted small scope-note" title={o.note}>
              {o.note}
            </span>
          </label>
        ))}
      </div>
      {targets.skipped.length > 0 && <div className="hint" style={{ marginTop: 8 }}>其中 {targets.skipped.length} 条还没预处理完或预处理失败，会跳过。</div>}
      <div className="hint" style={{ marginTop: 8 }}>
        每条视频按各自保存的配置出片（各画幅的填充 / 裁切在剪辑模块「成片画面」里设置）；本页只编辑当前这条，其他视频要同步配置可先用左侧「批量应用」。导出后在「产物」里查看成片。
      </div>
    </Modal>
  );
}

/** 名称输入框的示例日期，如「9月16日」。 */
function exportDateLabel(d = new Date()): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
