// 拖入 / 选择 JPG、PNG 加贴纸（HIG-46）的共用动作：挑出图片上传成贴纸素材，再按调用方给的位置加图层并切到「贴纸」模块。
// 画布、时间线、贴纸面板三处都走这里；位置与时段的算法在 lib/imageDrop。

import { api } from '../../api';
import { useEditor } from '../../store/editor';
import { rejectedText, splitByAccept } from '../../lib/fileDrop';
import { IMAGE_ACCEPT, IMAGE_ACCEPT_TEXT, newStickerLayer } from '../../lib/imageDrop';
import { newLayerId } from '../../lib/spec';
import { isAssetReady, type Asset, type StickerLayer } from '../../types';

type Placement = Partial<Pick<StickerLayer, 'anchor' | 'margin' | 'width' | 't'>>;

/** 挑出 JPG / PNG 上传；其余文件提示跳过。返回就绪的素材（没有可收的或上传失败时为空）。 */
export async function uploadImages(files: File[]): Promise<Asset[]> {
  const { setToast, loadAssets } = useEditor.getState();
  const { accepted, rejected } = splitByAccept(files, IMAGE_ACCEPT);
  const skipped = rejectedText(rejected, IMAGE_ACCEPT_TEXT);
  if (!accepted.length) {
    if (skipped) setToast(skipped);
    return [];
  }
  setToast(`正在上传 ${accepted.length} 张图片…${skipped ? `（${skipped}）` : ''}`);
  try {
    const uploaded = await api.uploadAssets('sticker', accepted);
    await loadAssets();
    setToast(skipped);
    return uploaded.filter((a) => isAssetReady(a));
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
 * 上传拖进来的图片后加图层。上传期间换了视频就不加到别的视频上，只提示已进素材库。
 * place 在上传完成后才调用，这时素材的宽高已知。
 */
export async function dropImages(files: File[], place: (asset: Asset, index: number) => Placement): Promise<void> {
  const videoId = useEditor.getState().currentVideoId;
  const assets = await uploadImages(files);
  if (!assets.length) return;
  if (useEditor.getState().currentVideoId !== videoId) {
    useEditor.getState().setToast(`${assets.length} 张图片已上传到素材库；已切换视频，没有自动添加`);
    return;
  }
  addStickerLayers(assets, place);
}
