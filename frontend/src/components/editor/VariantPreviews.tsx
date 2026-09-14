// 输出步骤：每个变体一个静态 canvas 预览（当前帧 + 填充模式 + 图层，含 layer_overrides）。

import { useEffect, useRef } from 'react';
import { useEditor, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { placeLayer } from '../../lib/layout';
import { effectivePlacement, layerAspect } from '../../lib/spec';
import { windowContains } from '../../lib/time';
import { ensureTextRendered } from '../../lib/textImage';
import { loadImage } from '../../lib/useImage';
import { VARIANT_DEFS, type EditSpec, type Asset, type OutputVariant, type TextLayer, type Video } from '../../types';

const PREVIEW_H = 300;

async function drawVariant(canvas: HTMLCanvasElement, video: Video, spec: EditSpec, variant: OutputVariant, assets: Asset[], postTime: number) {
  const def = VARIANT_DEFS.find((v) => v.key === variant.variant_key)!;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, W, H);

  // 源画面：优先 <video> 当前帧，否则封面
  let src: CanvasImageSource | null = player.getVideo();
  let sw = video.width;
  let sh = video.height;
  if (!src || (src as HTMLVideoElement).readyState < 2) {
    src = null;
    if (video.poster_url) {
      try {
        const img = await loadImage(video.poster_url);
        src = img;
        sw = img.naturalWidth;
        sh = img.naturalHeight;
      } catch {
        /* ignore */
      }
    }
  } else {
    sw = (src as HTMLVideoElement).videoWidth || sw;
    sh = (src as HTMLVideoElement).videoHeight || sh;
  }

  const coverScale = Math.max(W / sw, H / sh);
  const containScale = Math.min(W / sw, H / sh);
  const drawScaled = (scale: number) => {
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(src!, (W - dw) / 2, (H - dh) / 2, dw, dh);
  };
  if (src) {
    if (variant.fill === 'crop') drawScaled(coverScale);
    else {
      if (variant.fill === 'blur') {
        ctx.save();
        ctx.filter = 'blur(12px) brightness(0.7)';
        drawScaled(coverScale * 1.05);
        ctx.restore();
      } else {
        ctx.fillStyle = variant.color ?? '#000000';
        ctx.fillRect(0, 0, W, H);
      }
      drawScaled(containScale);
    }
  } else if (variant.fill === 'color') {
    ctx.fillStyle = variant.color ?? '#000000';
    ctx.fillRect(0, 0, W, H);
  }

  // 图层（按 def.width × def.height 的画布计算，再缩放到预览尺寸）
  const scale = W / def.width;
  for (const layer of spec.layers) {
    if (layer.visible === false || !windowContains(layer.t, postTime)) continue;
    const eff = effectivePlacement(layer, variant.layer_overrides?.[layer.id]);
    let image: CanvasImageSource | null = null;
    if (layer.type === 'sticker') {
      const a = assets.find((x) => x.id === layer.asset_id);
      if (a) {
        try {
          image = await loadImage(a.url);
        } catch {
          /* ignore */
        }
      }
    } else {
      image = (await ensureTextRendered(layer as TextLayer)).canvas;
    }
    if (!image) continue;
    const box = placeLayer({ anchor: eff.anchor, margin: eff.margin, width: eff.width }, layerAspect(layer, assets), { W: def.width, H: def.height });
    ctx.save();
    ctx.globalAlpha = eff.opacity;
    ctx.translate((box.x + box.w / 2) * scale, (box.y + box.h / 2) * scale);
    ctx.rotate((eff.rotate * Math.PI) / 180);
    ctx.drawImage(image, (-box.w / 2) * scale, (-box.h / 2) * scale, box.w * scale, box.h * scale);
    ctx.restore();
  }
}

function VariantBox({ variantKey, on, selected, onSelect }: { variantKey: string; on: boolean; selected: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const assets = useEditor((s) => s.assets);
  const postTime = usePostTime();
  const def = VARIANT_DEFS.find((v) => v.key === variantKey)!;
  const w = Math.round((PREVIEW_H * def.width) / def.height);
  const variant = spec?.outputs.find((o) => o.variant_key === variantKey) ?? { variant_key: def.key, aspect: def.aspect, fill: 'blur' as const };

  useEffect(() => {
    const c = ref.current;
    if (!c || !video || !spec) return;
    let alive = true;
    const id = requestAnimationFrame(() => {
      if (alive) void drawVariant(c, video, spec, variant, assets, postTime);
    });
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [video, spec, variant, assets, postTime]);

  return (
    <div className={`variant ${selected ? 'selected' : ''} ${on ? '' : 'off'}`} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
      <div className="vbox">
        <canvas ref={ref} width={w} height={PREVIEW_H} />
      </div>
      <div className="vcap">
        <b>{def.label}</b> · {on ? def.note : '未选'}
        {on && <div className="muted">{{ blur: '模糊背景', color: '纯色', crop: '裁切' }[variant.fill]}{variant.layer_overrides && Object.keys(variant.layer_overrides).length ? ' · 已微调' : ''}</div>}
      </div>
    </div>
  );
}

export function VariantPreviews() {
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const selected = useEditor((s) => s.selectedVariantKey);
  const setSelected = useEditor((s) => s.setSelectedVariant);
  const overrideMode = useEditor((s) => s.overrideMode);
  return (
    <>
      <div className="variants">
        {VARIANT_DEFS.map((d) => (
          <VariantBox key={d.key} variantKey={d.key} on={!!spec?.outputs.find((o) => o.variant_key === d.key)} selected={selected === d.key} onSelect={() => setSelected(d.key)} />
        ))}
      </div>
      <div className="override-bar">
        <span className="muted">
          {overrideMode ? `正在微调 ${selected} 变体的图层位置（右侧数值输入）` : '点击变体选择；非默认变体可在右侧勾选「在此变体上微调图层」写入 layer_overrides。'}
        </span>
      </div>
    </>
  );
}
