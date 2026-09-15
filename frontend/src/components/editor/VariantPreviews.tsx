// 输出步骤：每个变体一个 canvas 预览（当前帧 + 填充模式 + 图层，含 layer_overrides）。
//
// 重绘由一个常驻的 rAF 循环驱动，不跟着 React 每帧重渲染走：之前的写法把 postTime 放进
// effect 依赖里、在 effect 里排一次性 rAF，播放时 postTime 每帧变化，cleanup 会把上一帧
// 那个还没执行的 rAF 取消掉，绘制回调被自己饿死，画面永远停在进入这一步时的那帧（HIG-5）。

import { useEffect, useRef } from 'react';
import { useEditor, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { placeLayer } from '../../lib/layout';
import { isDefaultCrop } from '../../lib/crop';
import { isDue, previewIntervalMs } from '../../lib/previewClock';
import { coverBox, variantFrameBox } from '../../lib/videoBox';
import { effectivePlacement, layerAspect } from '../../lib/spec';
import { windowContains } from '../../lib/time';
import { ensureTextRendered } from '../../lib/textImage';
import { loadImage } from '../../lib/useImage';
import { getVideo } from '../../lib/useVideo';
import { isVideoAsset, VARIANT_DEFS, type EditSpec, type Asset, type OutputVariant, type TextLayer, type Video } from '../../types';

const PREVIEW_H = 300;

/** 未勾选变体的占位 variant，按 key 缓存：每次渲染新建对象会让下游 effect 无谓重跑。 */
const DEFAULT_VARIANTS = new Map<string, OutputVariant>(
  VARIANT_DEFS.map((d) => [d.key, { variant_key: d.key, aspect: d.aspect, fill: 'blur' as const }]),
);

interface DrawInput {
  video: Video;
  spec: EditSpec;
  variant: OutputVariant;
  assets: Asset[];
  postTime: number;
}

/**
 * 画一个变体。gen / current 用来丢弃过期的异步续体：图层要 await 图片和文字位图，
 * 期间可能又开了新一轮绘制，旧一轮不能再往画布上写。
 */
async function drawVariant(canvas: HTMLCanvasElement, input: DrawInput, gen: number, current: () => number): Promise<boolean> {
  const { video, spec, variant, assets, postTime } = input;
  const def = VARIANT_DEFS.find((v) => v.key === variant.variant_key)!;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d')!;

  // 源画面：优先 <video> 当前帧，否则封面
  const live = player.getVideo();
  let src: CanvasImageSource | null = live && live.readyState >= 2 ? live : null;
  let sw = video.width;
  let sh = video.height;
  let drewLiveFrame = false;
  if (src) {
    sw = (src as HTMLVideoElement).videoWidth || sw;
    sh = (src as HTMLVideoElement).videoHeight || sh;
    drewLiveFrame = true;
  } else if (video.poster_url) {
    try {
      const img = await loadImage(video.poster_url);
      if (gen !== current()) return false;
      src = img;
      sw = img.naturalWidth;
      sh = img.naturalHeight;
    } catch {
      /* ignore */
    }
  }

  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, W, H);

  if (src) {
    const { src: sBox, dst } = variantFrameBox(variant.fill, variant.crop, sw, sh, W, H);
    const paint = (box: typeof dst) => {
      if (sBox) ctx.drawImage(src!, sBox.x, sBox.y, sBox.w, sBox.h, box.x, box.y, box.w, box.h);
      else ctx.drawImage(src!, box.x, box.y, box.w, box.h);
    };
    if (variant.fill === 'crop') {
      paint(dst);
    } else {
      if (variant.fill === 'blur') {
        ctx.save();
        ctx.filter = 'blur(12px) brightness(0.7)';
        const bg = coverBox(sw, sh, W, H, 1.05);
        ctx.drawImage(src, bg.x, bg.y, bg.w, bg.h);
        ctx.restore();
      } else {
        ctx.fillStyle = variant.color ?? '#000000';
        ctx.fillRect(0, 0, W, H);
      }
      paint(dst);
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
      if (a && isVideoAsset(a)) {
        // 舞台那边已经把这个 <video>（同 URL 同实例）对齐到播放头，这里画它的当前帧；
        // 还没解出帧就退回首帧，和上面源画面的处理一致。
        const el = getVideo(a.preview_url ?? a.url);
        if (el.readyState >= 2) image = el;
        else if (a.poster_url) {
          try {
            image = await loadImage(a.poster_url);
          } catch {
            /* ignore */
          }
        }
      } else if (a) {
        try {
          image = await loadImage(a.url);
        } catch {
          /* ignore */
        }
      }
    } else {
      image = (await ensureTextRendered(layer as TextLayer)).canvas;
    }
    if (gen !== current()) return false;
    if (!image) continue;
    const box = placeLayer({ anchor: eff.anchor, margin: eff.margin, width: eff.width }, layerAspect(layer, assets), { W: def.width, H: def.height });
    ctx.save();
    ctx.globalAlpha = eff.opacity;
    ctx.translate((box.x + box.w / 2) * scale, (box.y + box.h / 2) * scale);
    ctx.rotate((eff.rotate * Math.PI) / 180);
    ctx.drawImage(image, (-box.w / 2) * scale, (-box.h / 2) * scale, box.w * scale, box.h * scale);
    ctx.restore();
  }
  return drewLiveFrame;
}

function VariantBox({ variantKey, on, selected, onSelect }: { variantKey: string; on: boolean; selected: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const assets = useEditor((s) => s.assets);
  const postTime = usePostTime();
  const def = VARIANT_DEFS.find((v) => v.key === variantKey)!;
  const w = Math.round((PREVIEW_H * def.width) / def.height);
  const variant = spec?.outputs.find((o) => o.variant_key === variantKey) ?? DEFAULT_VARIANTS.get(variantKey)!;

  // 绘制循环读的是 ref，不是闭包里的快照 —— 循环常驻，不随每次渲染重建。
  const inputRef = useRef<DrawInput | null>(null);
  inputRef.current = video && spec ? { video, spec, variant, assets, postTime } : null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let raf = 0;
    let gen = 0;
    let lastDrawn = -Infinity;
    let drawing = false;
    let everDrewLiveFrame = false;
    let lastKey = '';
    let visible = true;
    const current = () => gen;

    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); }, { threshold: 0.01 });
    io?.observe(c);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const input = inputRef.current;
      if (!input || drawing) return;

      const playing = player.isPlaying;
      const interval = previewIntervalMs({ playing, selected: selectedRef.current, visible });
      if (interval === null) return;

      // 暂停时按内容指纹去重，避免空转重画；播放时靠 interval 节流。
      const key = playing ? '' : `${input.postTime}|${input.variant.fill}|${JSON.stringify(input.variant.crop ?? null)}|${input.spec.layers.length}|${input.video.id}`;
      const now = performance.now();
      if (playing) {
        if (!isDue(now, lastDrawn, interval)) return;
      } else if (key === lastKey && everDrewLiveFrame) {
        return;
      }

      // 视频还没解码出帧、且已经画过真实帧时，保留上一帧，不要闪回封面。
      const live = player.getVideo();
      if (playing && everDrewLiveFrame && (!live || live.readyState < 2)) return;

      drawing = true;
      lastDrawn = now;
      lastKey = key;
      const myGen = ++gen;
      void drawVariant(c, input, myGen, current)
        .then((drewLive) => {
          if (drewLive) everDrewLiveFrame = true;
        })
        .catch(() => {
          /* 单帧画失败不影响循环 */
        })
        .finally(() => {
          drawing = false;
        });
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      gen++; // 让在途的异步绘制作废
      io?.disconnect();
    };
  }, []);

  return (
    <div className={`variant ${selected ? 'selected' : ''} ${on ? '' : 'off'}`} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
      <div className="vbox">
        <canvas ref={ref} width={w} height={PREVIEW_H} />
      </div>
      <div className="vcap">
        <b>{def.label}</b> · {on ? def.note : '未选'}
        {on && (
          <div className="muted">
            {{ blur: '模糊背景', color: '纯色', crop: '裁切' }[variant.fill]}
            {variant.fill === 'crop' && video && !isDefaultCrop(variant.crop, video.width, video.height, def.width / def.height) ? '（已调整范围）' : ''}
            {variant.layer_overrides && Object.keys(variant.layer_overrides).length ? ' · 已微调' : ''}
          </div>
        )}
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
