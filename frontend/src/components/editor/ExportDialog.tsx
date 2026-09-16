// 右上角「导出」弹窗（HIG-8）：选范围后保存并提交渲染。默认导出这一批；每条视频出一个 9:16 文件。
// 可选填一个导出名称（HIG-27），写到这次的每个任务上：产物页能按它搜，下载的文件名也用它。

import { useMemo, useState } from 'react';
import { useEditor } from '../../store/editor';
import { resolveExportTargets, type ExportScope } from '../../lib/exportScope';
import { Modal } from '../ui/Modal';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const videos = useEditor((s) => s.videos);
  const selectedIds = useEditor((s) => s.selectedIds);
  const currentId = useEditor((s) => s.currentVideoId);
  const rendering = useEditor((s) => s.rendering);
  const saveAndRender = useEditor((s) => s.saveAndRender);
  const [scope, setScope] = useState<ExportScope>('batch');
  const batchName = useEditor((s) => s.batch?.name ?? '');
  const [name, setName] = useState('');

  const current = videos.find((v) => v.id === currentId);
  const selectedCount = videos.filter((v) => selectedIds.includes(v.id)).length;
  const targets = useMemo(() => resolveExportTargets(videos, scope, selectedIds, currentId), [videos, scope, selectedIds, currentId]);

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
            disabled={rendering || targets.ids.length === 0}
            onClick={() => {
              void saveAndRender(targets.ids, { name });
              onClose();
            }}
          >
            {targets.ids.length ? `导出 ${targets.ids.length} 条` : '没有可导出的视频'}
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
        <span className="hint">产物页可按名称搜索；下载的文件名为「名称_视频名_9x16.mp4」，不填时用批次名。</span>
      </label>
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
        每条视频按各自保存的配置出一个 9:16 文件；本页只编辑当前这条，其他视频要同步配置可先用左侧「批量应用」。导出后在「产物」里查看成片。
      </div>
    </Modal>
  );
}

/** 名称输入框的示例日期，如「9月16日」。 */
function exportDateLabel(d = new Date()): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
