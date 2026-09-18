// 拖入 / 选择图片或视频加叠加素材（图片 HIG-46，视频 HIG-67）的共用动作：上传成贴纸素材，
// 再按调用方给的位置加图层并切到「贴纸」模块。
// 画布、时间线、贴纸面板三处都走这里；位置与时段的算法在 lib/imageDrop。

import { api } from '../../api';
import { useEditor } from '../../store/editor';
import { rejectedText, splitByAccept } from '../../lib/fileDrop';
import { newStickerLayer, OVERLAY_ACCEPT, OVERLAY_ACCEPT_TEXT } from '../../lib/imageDrop';
import { newLayerId } from '../../lib/spec';
import { isAssetReady, type Asset, type StickerLayer } from '../../types';

type Placement = Partial<Pick<StickerLayer, 'anchor' | 'margin' | 'width' | 't'>>;

const SETTLE_POLL_MS = 1500;
const SETTLE_TIMEOUT_MS = 120_000;
const isPreparing = (a: Asset) => (a.status ?? 'ready') === 'preparing';

/**
 * 视频素材上传完还要预处理（探测时长 / 宽高 / 有无音轨），没就绪就加不了图层——
 * 图片素材上传即就绪，走不到这里。轮询到都有结果、或超时为止，返回其中就绪的那些。
 */
async function settleAssets(uploaded: Asset[]): Promise<Asset[]> {
  const settled = uploaded.filter((a) => !isPreparing(a));
  const waiting = new Map(uploaded.filter(isPreparing).map((a) => [a.id, a]));
  if (!waiting.size) return settled.filter(isAssetReady);

  const { setToast, loadAssets } = useEditor.getState();
  setToast(`正在处理 ${waiting.size} 个视频素材…`);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (waiting.size && Date.now() < deadline) {
    await new Promise((r) => window.setTimeout(r, SETTLE_POLL_MS));
    for (const id of [...waiting.keys()]) {
      const a = await api.getAsset(id).catch(() => null);
      if (!a || isPreparing(a)) continue;
      waiting.delete(id);
      settled.push(a);
    }
  }
  await loadAssets();
  const ready = settled.filter(isAssetReady);
  const lost = uploaded.length - ready.length;
  setToast(lost > 0 ? `${lost} 个素材没有处理成功，没有添加` : null);
  return ready;
}

/** 挑出能收的图片 / 视频上传；其余文件提示跳过。返回就绪的素材（没有可收的或上传失败时为空）。 */
export async function uploadOverlays(files: File[]): Promise<Asset[]> {
  const { setToast, loadAssets } = useEditor.getState();
  const { accepted, rejected } = splitByAccept(files, OVERLAY_ACCEPT);
  const skipped = rejectedText(rejected, OVERLAY_ACCEPT_TEXT);
  if (!accepted.length) {
    if (skipped) setToast(skipped);
    return [];
  }
  setToast(`正在上传 ${accepted.length} 个素材…${skipped ? `（${skipped}）` : ''}`);
  try {
    const uploaded = await api.uploadAssets('sticker', accepted);
    await loadAssets();
    setToast(skipped);
    return settleAssets(uploaded);
  } catch (err) {
    setToast(`上传失败：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 给当前视频加一批贴纸图层（第 i 张的位置由 place 决定），选中第一张并切到「贴纸」模块。 */
export function addStickerLayers(assets: Asset[], place: (asset: Asset, index: number) => Placement): void {
  const { addLayers, setStep, step } = useEditor.getState();
  if (!assets.length) return;
  // 先切模块：setStep 会清掉选中，放在后面新图层就选不中了
  if (step !== 'sticker') setStep('sticker');
  addLayers(assets.map((a, i) => newStickerLayer(newLayerId(), a, place(a, i))));
}

/**
 * 上传拖进来的图片 / 视频后加图层。上传与预处理期间换了视频就不加到别的视频上，只提示已进素材库。
 * place 在素材就绪后才调用，这时宽高与时长都已知。
 */
export async function dropOverlays(files: File[], place: (asset: Asset, index: number) => Placement): Promise<void> {
  const videoId = useEditor.getState().currentVideoId;
  const assets = await uploadOverlays(files);
  if (!assets.length) return;
  if (useEditor.getState().currentVideoId !== videoId) {
    useEditor.getState().setToast(`${assets.length} 个素材已上传到素材库；已切换视频，没有自动添加`);
    return;
  }
  addStickerLayers(assets, place);
}
