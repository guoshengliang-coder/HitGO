import type { Video } from '../../types';

export type PillKind = 'preparing' | 'ready' | 'edited' | 'rendering' | 'done' | 'failed';

const LABELS: Record<PillKind, string> = {
  preparing: '准备中',
  ready: '未编辑',
  edited: '已编辑',
  rendering: '渲染中',
  done: '已完成',
  failed: '失败',
};

export function videoPillKind(v: Video, hasDraft?: boolean): PillKind {
  if (v.status === 'preparing') return 'preparing';
  if (v.status === 'failed' || v.render_status === 'failed') return 'failed';
  if (v.render_status === 'queued' || v.render_status === 'running') return 'rendering';
  if (v.render_status === 'done') return 'done';
  if (v.edited || hasDraft) return 'edited';
  return 'ready';
}

export function Pill({ kind, label }: { kind: PillKind | string; label?: string }) {
  return <span className={`pill ${kind}`}>{label ?? LABELS[kind as PillKind] ?? kind}</span>;
}

export const JOB_LABELS: Record<string, string> = { queued: '排队中', running: '渲染中', done: '已完成', failed: '失败' };
