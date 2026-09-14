# HitGO 原型 · 前后端契约

一期原型的唯一事实来源。前端、后端、渲染 worker 都按这份文件实现；改动先改这里。

## 0. 约定

- 所有 API 挂在 `/api` 前缀下，JSON 请求 / 响应，时间用 ISO 8601 字符串。
- 媒体文件（源片、代理、雪碧图、素材、成片、文字 PNG）通过 `/media/...` 路径访问，由后端静态服务；返回给前端的 `*_url` 字段都是以 `/media/` 开头的站内相对路径。
- 所有几何量用**相对比例**（0–1），相对于所在画布的宽或高；时间用秒（float）。
- ID 用短随机字符串（例如 `nanoid` 12 位），前后端都当不透明字符串处理。
- 错误统一返回 `{ "detail": "人类可读的中文说明" }`，HTTP 状态码按语义（400 / 404 / 409 / 500）。
- 访问控制：环境变量 `ACCESS_CODE` 非空时，所有 `/api` 与 `/media` 请求需要 Cookie `hitgo_access=<code>`；`POST /api/auth {code}` 校验后下发 Cookie（HttpOnly, SameSite=Lax, 30 天）。`GET /api/auth` 返回 `{ "required": bool, "ok": bool }`。前端未通过时显示访问码输入页。

## 1. 数据模型

### Batch（批次）

```json
{
  "id": "b_x1y2z3",
  "name": "9 月新手引导 A/B",
  "created_at": "2026-09-14T10:00:00Z",
  "video_count": 8,
  "status_counts": { "preparing": 0, "ready": 5, "edited": 2, "rendering": 1, "done": 0, "failed": 0 }
}
```

### Video（批次内的一条视频）

```json
{
  "id": "v_a1b2c3",
  "batch_id": "b_x1y2z3",
  "name": "V01 新手引导A.mp4",
  "order": 1,
  "status": "ready",              // preparing | ready | failed（预处理状态）
  "error": null,
  "width": 1080, "height": 1920, "duration": 24.6, "fps": 30, "has_audio": true,
  "source_url": "/media/batches/b_x1y2z3/v_a1b2c3/source.mp4",
  "proxy_url":  "/media/batches/b_x1y2z3/v_a1b2c3/proxy.mp4",
  "poster_url": "/media/batches/b_x1y2z3/v_a1b2c3/poster.jpg",
  "sprite": {                     // 时间轴缩略图雪碧图
    "url": "/media/batches/b_x1y2z3/v_a1b2c3/sprite.jpg",
    "interval": 1.0,              // 每格代表的秒数
    "tile_width": 90, "tile_height": 160,
    "columns": 10, "count": 25
  },
  "edit_spec": null,              // 见第 2 节；null 表示未编辑
  "edited": false,                // edit_spec 非空
  "render_status": "idle",        // idle | queued | running | done | failed（该视频最新一轮渲染任务的汇总）
  "updated_at": "2026-09-14T10:05:00Z"
}
```

### Asset（素材）

```json
{
  "id": "a_s1t2u3",
  "type": "sticker",              // sticker | font
  "name": "限时免费.png",
  "url": "/media/assets/a_s1t2u3.png",
  "width": 600, "height": 240,    // sticker 才有
  "family": "Alibaba PuHuiTi",    // font 才有：CSS font-family 名，由文件名去扩展名得到
  "source": "upload",             // upload | builtin（原型内置示例）
  "created_at": "..."
}
```

### Preset（用户保存的预设）

```json
{
  "id": "p_q1w2e3",
  "type": "text_style",           // 目前只有 text_style
  "name": "标题白字",              // 1–40 字符，前后空白会被去掉
  "data": { "font_family": "Noto Sans SC", "color": "#FFFFFF", "...": "..." },   // 与 type 对应的任意 JSON（text_style = 第 2 节的文字 style）
  "created_at": "..."
}
```

### Job（渲染任务 = 视频 × 输出变体）

```json
{
  "id": "j_r1s2t3",
  "batch_id": "b_x1y2z3",
  "video_id": "v_a1b2c3",
  "variant_key": "9x16",
  "status": "running",            // queued | running | done | failed
  "progress": 62,                 // 0–100
  "error": null,
  "output_url": null,             // done 时为 /media/outputs/j_r1s2t3.mp4
  "output": null,                 // done 时：{ "width", "height", "duration", "size", "codec": "h264/aac" }
  "callback": null,               // done 时：第 4 节的回传 JSON（原型只展示，不真正发送）
  "created_at": "...", "started_at": null, "finished_at": null
}
```

## 2. edit_spec v1

保存在 Video 上，前端产出，worker 消费。

```jsonc
{
  "spec_version": 1,
  "trim": {
    "remove": [[3.2, 5.8], [17.0, 18.4]]     // 秒，基于源视频时间轴，互不重叠、升序
  },
  "layers": [
    {
      "id": "l_1",
      "type": "sticker",
      "asset_id": "a_s1t2u3",
      "anchor": "top-left",                  // 见下方九个锚点
      "margin": [0.08, 0.12],                // [x, y]，相对画布宽 / 高，从锚点所在边向内量；中心锚点时为相对中心的偏移
      "width": 0.35,                         // 相对画布宽；高度按素材宽高比推出
      "rotate": 0,                           // 角度，绕图层中心
      "opacity": 1,
      "t": [0, 6]                            // 出现时段，秒，基于剪后时间轴；"all" 表示全程
    },
    {
      "id": "l_2",
      "type": "text",
      "text": "限时免费",
      "style": {
        "font_family": "Noto Sans SC", "font_weight": 700,
        "font_size": 0.05,                   // 相对画布高
        "color": "#FFFFFF", "stroke_color": "#000000", "stroke_width": 0.004,   // 相对画布高
        "background": null,                  // 或 "#00000099"
        "padding": 0.01,                     // 相对画布高
        "align": "center", "line_height": 1.2,
        "shadow": { "color": "#00000080", "blur": 0.01, "offset": [0.002, 0.004] },   // 可选；blur / offset 相对画布高；null = 无阴影
        "letter_spacing": 0.02               // 可选，em 单位，可为负
      },
      "image_url": "/media/uploads/u_9k8j.png",   // 前端按输出分辨率渲染好的透明 PNG；worker 只用它
      "image_size": [540, 130],              // 该 PNG 的像素尺寸
      "anchor": "top-center", "margin": [0, 0.06],
      "width": 0.5,                          // 相对画布宽；PNG 按此缩放
      "rotate": 0, "opacity": 1, "t": "all"
    }
  ],
  "outputs": [
    { "variant_key": "9x16", "aspect": "9:16", "fill": "blur", "quality": "high" },
    { "variant_key": "1x1",  "aspect": "1:1",  "fill": "blur",
      "layer_overrides": { "l_1": { "margin": [0.05, 0.05], "width": 0.3 } } }
  ]
}
```

规则：

- **锚点**：`top-left | top-center | top-right | center-left | center | center-right | bottom-left | bottom-center | bottom-right`。
- **图层位置换算**（画布 W×H 像素，图层宽 w = width·W，高 h 由素材宽高比推出）：
  - x：left → `margin.x·W`；center → `(W−w)/2 + margin.x·W`；right → `W − w − margin.x·W`
  - y：top → `margin.y·H`；center → `(H−h)/2 + margin.y·H`；bottom → `H − h − margin.y·H`
  - 前端 Konva 与后端 FFmpeg 都按这一套公式；旋转绕图层中心。
- **时间轴**：`trim.remove` 基于源时间轴；`layers[].t` 基于剪后时间轴。前端在剪辑区间变化时不自动改图层时段，只在图层步骤里对落在已删区间外的图层给提示。
- **输出画幅**：`9:16 → 1080×1920`，`1:1 → 1080×1080`，`4:5 → 1080×1350`，`16:9 → 1920×1080`。`fill`：`blur`（源画面放大模糊铺底 + 原画面居中 contain）| `color`（配 `"color": "#000000"`）| `crop`（cover 居中裁切）。
- 至少有一个输出；`variant_key` 在同一 spec 内唯一，`9x16` 视为默认变体（回传语义"替换原素材"，其余为派生）。
- **输出质量**：`quality`：`standard`（默认，省略即 standard）| `high`；决定第 6 节的编码档位，每个输出变体独立设置。
- `layer_overrides` 只允许覆盖 `anchor | margin | width | rotate | opacity`。
- 文字图层没有 `image_url` 时 worker 跳过该图层并在 job.error 里记警告（不失败）。
- **文字 `style` 全部由前端渲染**进 `image_url` 的 PNG；后端只做 schema 校验并原样保存。`shadow`（`{ color, blur, offset: [x, y] }`，可为 null）与 `letter_spacing`（em，可为负）都是可选字段，worker 不读取。

## 3. API

### 认证
- `GET /api/auth` → `{ required, ok }`
- `POST /api/auth` `{ code }` → 200 设 Cookie / 401

### 批次
- `GET /api/batches` → `Batch[]`（按创建时间倒序）
- `POST /api/batches` `{ name }` → `Batch`
- `GET /api/batches/{id}` → `Batch & { videos: Video[] }`
- `DELETE /api/batches/{id}` → 204（删除视频、任务、文件）
- `POST /api/batches/{id}/videos` multipart，字段 `files`（多文件，mp4 / mov）→ `Video[]`，每条立即入队预处理
- `POST /api/batches/{id}/apply` `{ source_video_id, target_video_ids: [], modules: ["trim"|"layers"|"outputs"], layer_mode?: "replace"|"style_only" }` → `Video[]`（被更新的目标）。规则：把源 spec 的对应模块深拷贝到目标；目标没有 spec 时先建空 spec；`trim` 模块套用时若目标时长更短，丢弃超出的区间。
  - `layer_mode`（只影响 `layers` 模块，默认 `replace`）：
    - `replace`：目标的图层列表整体替换为源的深拷贝（原有行为）。
    - `style_only`：源图层逐个匹配目标图层——先按相同 `id`；文字图层没有 id 匹配时退而找第一个 `text` 完全相同的目标文字图层（每个目标图层最多被匹配一次）。匹配上的目标只覆盖类型相关字段（贴纸：`asset_id`；文字：`text | style | image_url | image_size`）以及 `width | rotate | opacity`，保留目标自己的 `anchor | margin | t` 与其它键；没匹配上的源图层深拷贝追加到末尾。目标没有图层时等价于 `replace`。
- `GET /api/batches/{id}/jobs` → `Job[]`（该批次全部任务，按创建时间倒序）
- `GET /api/batches/{id}/outputs` → `Job[]`（status = done，按视频 order、variant_key 排）

### 视频
- `GET /api/videos/{id}` → `Video`
- `PUT /api/videos/{id}/spec` `{ edit_spec }` → `Video`（服务端做 schema 校验，400 返回具体字段）
- `DELETE /api/videos/{id}` → 204

### 素材
- `GET /api/assets?type=sticker|font` → `Asset[]`
- `POST /api/assets` multipart：`type`，`files`（png / webp / gif 静态 / ttf / otf / woff2）→ `Asset[]`
- `DELETE /api/assets/{id}` → 204

### 文字图层 PNG
- `POST /api/uploads/layer-image` multipart：`file`（png）→ `{ url, width, height }`

### 渲染
- `POST /api/render` `{ video_ids: [] }` → `Job[]`。每个视频按其 spec 的 `outputs` 生成任务；已有 queued / running 任务的同一 video+variant 不重复建（409 列出冲突）。
- `GET /api/jobs/{id}` → `Job`
- `POST /api/jobs/{id}/retry` → `Job`（failed 才允许）
- `GET /api/jobs?ids=a,b,c` → `Job[]`（前端轮询进度，1.5 秒一次）

### 预设
- `GET /api/presets?type=text_style` → `Preset[]`（按创建时间倒序；`type` 必填，非法值 400）
- `POST /api/presets` `{ type, name, data }` → 201 `Preset`（`type` 目前只接受 `text_style`，否则 400；`name` 去掉前后空白后 1–40 字符）
- `DELETE /api/presets/{id}` → 204 / 404

### 配置
- `GET /api/safe-zones` → `SafeZone[]`：

```json
[
  { "key": "generic-vertical", "name": "通用竖版", "aspect": "9:16",
    "note": "仅供参考：…（示意，非官方素材）",
    "overlay_url": "/api/overlays/generic-vertical.png",     // 可为 null：平台界面示意图（1080×1920 透明 PNG）
    "inner": { "label": "安全区（保守）", "x": 0.06, "y": 0.12, "w": 0.76, "h": 0.62 },   // 可为 null：保守安全框
    "outer": { "label": "安全区（宽松）", "x": 0.03, "y": 0.08, "w": 0.82, "h": 0.70 },   // 可为 null：宽松安全框（包含 inner）
    "zones": [
      { "label": "顶部状态栏 / 标题", "x": 0, "y": 0, "w": 1, "h": 0.08 },
      { "label": "右侧互动区", "x": 0.85, "y": 0.35, "w": 0.15, "h": 0.35 },
      { "label": "底部文案 / 按钮", "x": 0, "y": 0.78, "w": 1, "h": 0.22 }
    ] },
  { "key": "douyin", "name": "巨量 / 抖音", "aspect": "9:16", "overlay_url": "/api/overlays/douyin.png", "inner": { ... }, "outer": { ... }, "zones": [ ... ] },
  { "key": "kuaishou", "name": "磁力 / 快手", "aspect": "9:16", "overlay_url": "...", "inner": { ... }, "outer": { ... }, "zones": [ ... ] },
  { "key": "tencent", "name": "广点通 / 视频号", "aspect": "9:16", "overlay_url": "...", "inner": { ... }, "outer": { ... }, "zones": [ ... ] },
  { "key": "meta", "name": "Meta Reels", "aspect": "9:16", "overlay_url": "...", "inner": { ... }, "outer": { ... }, "zones": [ ... ] },
  { "key": "google", "name": "Google / YouTube Shorts", "aspect": "9:16", "overlay_url": "...", "inner": { ... }, "outer": { ... }, "zones": [ ... ] }
]
```
后端从 `backend/app/data/safe_zones.json` 读取。数值按公开资料估算，标注"仅供参考"。`overlay_url | inner | outer` 都是可选字段（缺省 null），矩形的 `label` 可为空串；`inner` 为保守安全框（放关键文案 / CTA），`outer` 为宽松安全框，inner ⊆ outer。

- `GET /api/overlays/{key}.png` → `image/png`（`Cache-Control: public, max-age=86400`）；`key` 必须是 safe-zones 里的 `key`，否则 404。返回 1080×1920 透明 PNG，画的是该平台信息流界面的**近似示意**（半透明白 / 黑线框 + 拉丁占位文字，非官方素材），前端按画布等比缩放叠在预览上。文件由 `backend/scripts/gen_overlays.py` 生成并提交在 `backend/app/data/overlays/`。和其它 `/api` 路由一样受访问码限制。

## 4. 回传 JSON（原型只展示）

Job 完成时生成并存到 `job.callback`，"已回传"页展示：

```json
{
  "session_id": "b_x1y2z3",
  "source_id": "v_a1b2c3",
  "variant_key": "9x16",
  "status": "done",
  "output": { "url": "https://hitgo.example/media/outputs/j_r1s2t3.mp4", "duration": 22.4, "width": 1080, "height": 1920, "size": 5832211, "codec": "h264/aac" },
  "edit_spec": { "...": "..." },
  "operator": { "id": "demo", "name": "演示用户" },
  "idempotency_key": "b_x1y2z3:v_a1b2c3:9x16:1"
}
```
`output.url` 用环境变量 `PUBLIC_BASE_URL` 拼绝对地址。

## 5. 存储布局（本地磁盘，`DATA_DIR` 默认 `/data`）

```
/data/hitgo.db                               SQLite（DATABASE_URL 可换 PostgreSQL）
/data/batches/{batch_id}/{video_id}/source.mp4 | proxy.mp4 | poster.jpg | sprite.jpg
/data/assets/{asset_id}.{ext}
/data/uploads/{upload_id}.png
/data/outputs/{job_id}.mp4
/data/tmp/                                    worker 临时文件
```
`/media` 直接映射到 `DATA_DIR`（`hitgo.db` 和 `tmp/` 不对外）。

## 6. 预处理与渲染（worker）

### 预处理（每条视频入库后）
1. `ffprobe -v error -print_format json -show_format -show_streams`
2. 代理：`-vf "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)'" -c:v libx264 -preset veryfast -crf 28 -profile:v baseline -level 3.1 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart`
3. 雪碧图：`-vf "fps=1,scale=90:-2,tile=10x{rows}"`，rows = ceil(duration / 10)，记录 count/tile 尺寸
4. 封面：第 0.5 秒一帧 `poster.jpg`

### 渲染（每个 job）
1. 解析 spec，取输出画幅 W×H，读取图层素材 / PNG。
2. `filter_complex` 顺序：
   - 源 → `trim`/`atrim` 切保留段 → `concat`（无 remove 时跳过；无音轨时只处理视频）
   - 画幅：`blur` = `split` → 一路 `scale` 到 cover + `boxblur=20` + `crop=W:H`，另一路 `scale` 到 contain，`overlay` 居中；`color` = `scale` contain + `pad=W:H:(ow-iw)/2:(oh-ih)/2:color`；`crop` = `scale` cover + `crop=W:H`
   - 图层：按顺序 `[img]scale=w:-1,rotate=...:c=none:ow=rotw:oh=roth,format=rgba,colorchannelmixer=aa=opacity[li]`，`overlay=x:y:enable='between(t,a,b)'`（`t="all"` 不加 enable）
   - 输出 `format=yuv420p`
3. 编码（按输出变体的 `quality`，1080p）：
   - `standard`（默认）：`-c:v libx264 -preset veryfast -crf 20 -maxrate 8M -bufsize 16M -c:a aac -b:a 128k -movflags +faststart`
   - `high`：`-c:v libx264 -preset medium -crf 19 -maxrate 10M -bufsize 20M -c:a aac -b:a 128k -movflags +faststart`
4. 进度：`-progress pipe:1 -nostats`，解析 `out_time_us` / 剪后总时长 → `progress`，每秒最多写库一次。
5. 完成：ffprobe 成片得到 duration / 宽高 / size，写 `output`、`callback`，状态 done；失败写 `error`（截取 ffmpeg stderr 最后 40 行）。

## 7. 运行方式

- 本地开发：`backend/` 用 `uv run uvicorn app.main:app --reload`（端口 8000），`frontend/` 用 `npm run dev`（Vite，`/api` 与 `/media` 代理到 8000）。
- 容器：单一镜像 `hitgo`（多阶段：node 构建前端 → python:3.12-slim + apt ffmpeg + uv），`api` 与 `worker` 两个服务共用；`redis:7-alpine`。API 同时托管前端静态文件（`/` → `frontend/dist`，SPA fallback）。
- 环境变量：`DATA_DIR`、`DATABASE_URL`、`REDIS_URL`、`ACCESS_CODE`、`PUBLIC_BASE_URL`、`WORKER_CONCURRENCY`（默认 1）。
- 服务器：`docker compose` 监听 `127.0.0.1:8790`，nginx `hitgo.mrlgs.net` 反代，见 `docs/DEPLOY.md`。
