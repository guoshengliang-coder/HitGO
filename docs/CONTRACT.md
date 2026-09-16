# HitGO 原型 · 前后端契约

一期原型的唯一事实来源。前端、后端、渲染 worker 都按这份文件实现；改动先改这里。

## 0. 约定

- 所有 API 挂在 `/api` 前缀下，JSON 请求 / 响应，时间用 ISO 8601 字符串。
- 媒体文件（源片、代理、雪碧图、素材、成片、文字 PNG）通过 `/media/...` 路径访问，由后端静态服务；返回给前端的 `*_url` 字段都是以 `/media/` 开头的站内相对路径。**唯一例外**：`source = "library"` 的素材（将来对接正式物料库时才出现）其 `url` 可以是外部 `https://` 绝对地址，前端一律当不透明 URL 直接用；见 `docs/ASSETS.md`。
- 所有几何量用**相对比例**（0–1），相对于所在画布的宽或高；时间用秒（float）。
- ID 用短随机字符串（例如 `nanoid` 12 位），前后端都当不透明字符串处理。
- 错误统一返回 `{ "detail": "人类可读的中文说明" }`，HTTP 状态码按语义（400 / 404 / 409 / 500）。
- 访问控制：环境变量 `ACCESS_CODE` 非空时，所有 `/api` 与 `/media` 请求需要 Cookie `hitgo_access=<code>`；`POST /api/auth {code}` 校验后下发 Cookie（HttpOnly, SameSite=Lax, 30 天）。`GET /api/auth` 返回 `{ "required": bool, "ok": bool }`。前端未通过时显示访问码输入页。**唯一例外**：`POST /api/assets` 带有效的请求头 `X-Upload-Ticket`（由 `POST /api/assets/upload-ticket` 签发）时不看 Cookie，见第 3 节「素材」的上传子域名。

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
  "separation": null,             // 可选；人声 / 伴奏分离状态，见下；null = 从未分离
  "updated_at": "2026-09-14T10:05:00Z"
}
```

**人声 / 伴奏分离 `separation`**（可选，缺省 null）：对源视频的音轨跑一次 AI 音源分离（Demucs），产出两个
`type = "audio"`、`source = "derived"` 的素材，直接用在第 2 节 `audio.tracks[]` 里（配合 `align = "source"`）：

```jsonc
{
  "status": "done",               // queued | running | done | failed
  "model": "htdemucs",            // htdemucs（默认）| htdemucs_ft（四模型集成，慢约 4 倍）
  "error": null,                  // failed 时的中文原因
  "vocals_asset_id": "a_v0c4l5",  // done 才有：人声轨素材
  "instrumental_asset_id": "a_1n5tr",   // done 才有：伴奏（去人声）轨素材
  "updated_at": "..."
}
```

### Asset（素材）

```jsonc
{
  "id": "a_s1t2u3",
  "type": "sticker",              // sticker | font | audio
  "kind": "image",                // 可选，缺省 "image"：image | video（sticker）| audio（audio 素材固定为 audio）
  "status": "ready",              // 可选，缺省 "ready"：preparing | ready | failed（视频贴纸 / 音频素材异步预处理）
  "error": null,                  // status = failed 时的中文原因
  "name": "限时免费.png",
  "url": "/media/assets/a_s1t2u3.png",
  "width": 600, "height": 240,    // sticker 才有；视频贴纸在 status = ready 后才有
  "duration": 2.4,                // 可选；kind = video | audio 才有，秒
  "fps": 30,                      // 可选；kind = video 才有
  "has_alpha": true,              // 可选；kind = video 才有：素材是否带透明通道
  "has_audio": false,             // 可选；kind = video 且预处理完才有：素材是否带音轨（null = 未知，旧素材回填前）
  "poster_url": "/media/assets/a_s1t2u3.poster.jpg",    // 可选；kind = video 且 ready 才有：首帧
  "preview_url": "/media/assets/a_s1t2u3.preview.webm?v=1757923200", // 可选；kind = video 且 ready 才有：浏览器可播的预览代理
  "family": "Alibaba PuHuiTi",    // font 才有：CSS font-family 名，由文件名去扩展名得到
  "source": "upload",             // upload（我手动上传）| builtin（仓库 samples/ 里的内置示例）| library（正式物料库，原型阶段不产生）| derived（系统从某条视频分离出来的）
  "derived_from": null,           // 可选；source = derived 才有：{ "video_id", "video_name", "stem": "vocals" | "instrumental" }
  "created_at": "..."
}
```

`poster_url` / `preview_url` 可能带 `?v=<文件修改时间>`：这两个派生文件会被原地重新生成（例如音轨回填），
带版本号是为了让浏览器不继续用旧缓存。前端把它们当不透明 URL 使用即可。

**视频贴纸**（`kind = "video"`）：上传 `mp4 / mov / webm`，或多帧的 `gif / webp`。落盘后由 worker 异步
探测（`preparing`），拿到宽高 / 时长 / 帧率 / 是否带透明通道，并生成首帧 `poster` 与浏览器可播的
`preview` 代理，完成后转 `ready`；失败转 `failed` 并写 `error`。`preparing` 期间素材可以列出但不能用于
渲染（worker 会跳过并记警告）。

**音频素材**（`type = "audio"`，`kind = "audio"`）：上传 `mp3 / wav / m4a`，落盘后由 worker 异步 `ffprobe`
时长（`preparing` → `ready`），没有 poster / preview 派生文件，`url` 就是原文件（浏览器能直接播）。
`width / height / fps / has_alpha / has_audio / poster_url / preview_url` 一律为 null。用在第 2 节 `audio.tracks[]`
里作 BGM / 口播；`preparing` 期间可以列出但不能用于渲染（worker 跳过并记警告）。

**分离出来的音轨**（`source = "derived"`）：由 `POST /api/videos/{id}/separate` 产生，`type = audio`、`kind = audio`、
`status = ready`，时长等于源视频；`derived_from` 记录来自哪条视频的哪个声部。它和上传的音频一样可以用在任何
视频的 `audio.tracks[]` 里，也可以删除；再次分离同一条视频会替换掉上一次的两个素材（引用旧素材的音轨渲染时会
跳过并记警告）。

**透明通道**：`mp4`（H.264）没有 alpha 通道，只能作为不透明矩形叠加；`mov`（ProRes 4444 /
QuickTime RLE / HEVC-with-alpha）与 `webm`（VP8/VP9 alpha）可以带透明。前端按 `has_alpha` 给出提示。

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
  "created_at": "...", "started_at": null, "finished_at": null,
  "batch_name": null,             // 只有跨批次的 GET /api/outputs 会填；其余端点为 null
  "video_name": null              // 同上
}
```

`batch_name` / `video_name` 是给跨批次列表用的冗余字段：`GET /api/outputs` 一次返回来自不同批次的
任务，调用方没法像单批次页面那样再拉一次 `GET /api/batches/{id}` 去查名字。其余返回 `Job` 的端点
一律为 `null`，调用方仍从批次详情里取名。

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
      "t": [0, 6],                           // 出现时段，秒，基于剪后时间轴；"all" 表示全程
      "playback": "loop",                    // 可选，缺省 "loop"：视频贴纸短于 t 时段时 loop | freeze | once
      "mix_audio": false                     // 可选，缺省 false：视频贴纸自带的音轨是否合成进成片
    },
    {
      "id": "l_2",
      "type": "text",
      "text": "限时免费",
      "spans": [ { "start": 0, "end": 2, "color": "#E3312B" } ],   // 可选；局部上色：text 的 UTF-16 字符区间 [start,end) 用 color 填充，升序且互不重叠；缺省 / [] = 整段用 style.color
      "style": {
        "font_family": "Noto Sans SC", "font_weight": 700,
        "font_size": 0.05,                   // 相对画布高
        "color": "#FFFFFF", "stroke_color": "#000000", "stroke_width": 0.004,   // 相对画布高
        "background": null,                  // 或 "#00000099"
        "padding": 0.01,                     // 相对画布高
        "align": "center", "line_height": 1.2,
        "shadow": { "color": "#00000080", "blur": 0.01, "offset": [0.002, 0.004] },   // 可选；blur / offset 相对画布高；null = 无阴影
        "glow": { "color": "#FF7A1ACC", "blur": 0.014 },   // 可选；blur 相对画布高；null = 无发光
        "letter_spacing": 0.02,              // 可选，em 单位，可为负
        "background_width": null,            // 可选；背景块宽度，相对画布宽 (0,1]，1 = 通栏；null / 缺省 = 紧贴文字，文字按 align 在块内排
        "background_radius": null            // 可选；背景圆角，相对画布高；null / 缺省 = 自动（min(padding, font_size×0.2)）
      },
      "image_url": "/media/uploads/u_9k8j.png",   // 前端按输出分辨率渲染好的透明 PNG；worker 只用它
      "image_size": [540, 130],              // 该 PNG 的像素尺寸
      "anchor": "top-center", "margin": [0, 0.06],
      "width": 0.5,                          // 相对画布宽；PNG 按此缩放
      "rotate": 0, "opacity": 1, "t": "all"
    },
    {
      "id": "l_3",
      "type": "mask",                        // 遮盖层：把画面上的一块区域模糊或盖上色块（遮原字幕），不需要素材
      "mode": "blur",                        // 可选，缺省 blur：blur 区域模糊 | solid 色块
      "blur": 2,                             // 可选，缺省 2：强度档 1 | 2 | 3，只对 blur 生效
      "color": "#000000",                    // 可选，缺省 #000000：#RRGGBB，只对 solid 生效；透明度用 opacity
      "anchor": "bottom-center", "margin": [0, 0.10],
      "width": 1.0, "height": 0.12,          // height 相对画布高（遮盖没有素材宽高比）
      "rotate": 0, "opacity": 1, "t": [0, 6]
    }
  ],
  "outputs": [
    { "variant_key": "9x16", "aspect": "9:16", "fill": "blur", "quality": "high" },
    { "variant_key": "1x1",  "aspect": "1:1",  "fill": "blur",
      "layer_overrides": { "l_1": { "margin": [0.05, 0.05], "width": 0.3 } } },
    { "variant_key": "4x5",  "aspect": "4:5",  "fill": "crop",
      "crop": { "x": 0.3418, "y": 0, "w": 0.3164, "h": 1 } }   // 可选：源画面上的裁切窗口，见下方规则
  ],
  "audio": {                                 // 可选；缺省 = 源音轨原样保留（即此前的行为）
    "source_volume": 1,                      // 0–1；0 = 源音轨静音（相当于剪映「分离音频 → 删除」）
    "tracks": [
      {
        "id": "au_1",
        "asset_id": "a_bgm001",              // Asset.type = "audio"
        "role": "bgm",                       // 可选，缺省 "bgm"：bgm | voice，只给界面分类，worker 不区分
        "t": "all",                          // 出声时段，秒，基于剪后时间轴；同 layers[].t
        "align": "post",                     // 可选，缺省 "post"：post = 素材从时段起点开始播 | source = 素材对齐源时间轴（分离出的人声 / 伴奏用），见下方规则
        "offset": 0,                         // 可选，缺省 0：从素材第几秒开始播；loop = true 时必须为 0
        "volume": 1,                         // 可选，缺省 1：0–1
        "loop": false,                       // 可选，缺省 false：素材短于时段时循环；false 播完即静音
        "fade_in": 0, "fade_out": 0          // 可选，缺省 0：秒；两者之和不能超过时段长
      }
    ]
  },
  "cover": {                                 // 可选；缺省 null = 没有封面（即此前的行为）
    "asset_id": "a_c0v3r1",                  // Asset.type = "sticker"：图片或视频（kind = image | video）
    "duration": 1.0                          // 可选，缺省 1.0：秒，0.1–10；只对图片封面生效
  }
}
```

规则：

- **锚点**：`top-left | top-center | top-right | center-left | center | center-right | bottom-left | bottom-center | bottom-right`。
- **图层位置换算**（画布 W×H 像素，图层宽 w = width·W，高 h 由素材宽高比推出；遮盖层 h = height·H）：
  - x：left → `margin.x·W`；center → `(W−w)/2 + margin.x·W`；right → `W − w − margin.x·W`
  - y：top → `margin.y·H`；center → `(H−h)/2 + margin.y·H`；bottom → `H − h − margin.y·H`
  - 前端 Konva 与后端 FFmpeg 都按这一套公式；旋转绕图层中心。
- **时间轴**：`trim.remove` 基于源时间轴；`layers[].t` 基于剪后时间轴。前端在剪辑区间变化时不自动改图层时段，只在文本 / 贴纸模块里对落在已删区间外的图层给提示。
- **输出画幅**：`9:16 → 1080×1920`，`1:1 → 1080×1080`，`4:5 → 1080×1350`，`16:9 → 1920×1080`。`fill`：`blur`（源画面放大模糊铺底 + 原画面居中 contain）| `color`（配 `"color": "#000000"`）| `crop`（cover 居中裁切）。
- **裁切窗口 `crop`**（可选，默认 null）：源画面上的裁切矩形，`{ x, y, w, h }` 均为相对源宽 / 高的 0–1 比例，`0 < w, h ≤ 1`，`x + w ≤ 1`，`y + h ≤ 1`。**只在 `fill = "crop"` 时生效**，其它 fill 忽略；缺省等价于现在的 cover 居中裁切。worker 先按窗口裁出源区域，再 cover 居中缩放到输出画幅——窗口比例与画幅不一致时不会变形，只会再居中裁一次。用途：横屏源里只取正中的竖版内容区。批量套用 `outputs` 模块时原样复制（相对比例，跨分辨率可用）。
- 至少有一个输出；`variant_key` 在同一 spec 内唯一，`9x16` 视为默认变体（回传语义"替换原素材"，其余为派生）。
- **编辑器只产出一个 `9x16` 输出**（HIG-8）：前端载入、批量应用回填和导出前都会把 spec 收成只含一个 `9x16` 的 `outputs`（保留它的 `fill` / `color` / `crop` / `quality`，去掉其他变体与 `layer_overrides`；没有 `9x16` 时沿用第一个变体的 `fill` / `color` / `quality` 新建，`crop` 丢弃），并自动保存写回。多画幅字段、后端校验与 worker 行为不变，上面的示例仍是合法 spec，只是编辑器不再产生这种形状。
- **输出质量**：`quality`：`standard`（默认，省略即 standard）| `high`；决定第 6 节的编码档位，每个输出变体独立设置。
- `layer_overrides` 只允许覆盖 `anchor | margin | width | height | rotate | opacity`（`height` 只对遮盖层有意义，其它类型忽略）。
- **遮盖层 `type = "mask"`**：把画布上的一块矩形区域模糊或盖上色块，典型用途是遮住烧进画面的原字幕再叠新字幕；不需要任何素材。
  - 位置换算同其它图层，`h = height·H`（`height` 缺省 0.12，(0, 1]）；`rotate` 忽略。超出画布的部分裁掉，剩余不足 2×2 px 时 worker 跳过该图层并在 job.error 里记警告（不失败）。
  - `mode = "blur"`（缺省）：区域模糊，`blur` 档位 1 / 2 / 3 = `boxblur=10:1 / 20:2 / 40:3`，半径自动收到 `min(w, h) / 2 − 1`（收到 0 时跳过并记警告）；`opacity` 是模糊层按透明度叠回原画面的比例。
  - `mode = "solid"`：用 `color`（`#RRGGBB`）盖住区域，`opacity` 是色块的 alpha。
  - 层级按 `layers` 数组顺序：编辑器新建 / 粘贴遮盖层时插到第一个文字图层之前，所以遮盖永远压在字幕之下；用户仍可在同类里调层级。
  - 批量套用 `style_only` 时复制 `mode | color | blur | height`（+ 公共的 `width | rotate | opacity`），未匹配的遮盖层插到目标第一个文字图层之前而不是追加到末尾。
  - 编辑器预览用 `backdrop-filter` 模糊 / 色块 div 实时叠在画面上，只是近似；成片效果以 worker 为准。遮盖只是模糊 / 色块，不是无痕擦除。
- 文字图层没有 `image_url` 时 worker 跳过该图层并在 job.error 里记警告（不失败）。贴纸素材不存在、或
  视频贴纸还没预处理完（`status != "ready"`）时同样跳过并记警告。
- **贴纸播放 `playback`**（可选，默认 `"loop"`）：只对视频贴纸（`Asset.kind = "video"`，含多帧 gif / webp）
  生效，静态图忽略。素材时长短于 `t` 时段时 —— `loop` 循环播放；`freeze` 播完定格最后一帧；`once` 播完
  消失。素材比时段长时一律在时段结束处截断。批量套用 `style_only` 时 `playback` 跟随 `asset_id` 一起复制。
- **贴纸音轨 `mix_audio`**（可选，默认 `false`）：只对带音轨的视频贴纸（`Asset.kind = "video"` 且
  `has_audio = true`）生效，其它贴纸与 `false` 一律忽略——成片音轨只来自源视频（即此前的行为）。为 `true`
  时贴纸音轨按原音量叠加到成片音轨上（不做音量调节，也不压低源视频音量）：只在 `t` 时段内出声，从
  贴纸自己的第 0 秒开始；`loop` 时随画面循环，`freeze` / `once` 只放一遍；时段结束处截断。源视频
  没有音轨时成片音轨就是贴纸音轨（其余时间静音）。编辑器预览按同样的规则出声。批量套用
  `style_only` 时 `mix_audio` 跟随 `asset_id` 一起复制。
- **音轨 `audio`**（可选，缺省 null）：成片音轨 = 源音轨（剪辑后）× `source_volume` + 各贴纸 `mix_audio`
  音轨 + 各 `tracks`，按原音量直接叠加（`amix normalize=0`），不做闪避（ducking）。规则：
  - `source_volume = 0` 或源视频没有音轨时，用静音垫底；此时若也没有任何叠加音轨，成片就没有音轨。
  - 每条 track 只在 `t` 时段内出声，从素材的第 `offset` 秒起；`loop = true` 时素材播完从头循环（所以要求
    `offset = 0`），`false` 时播完即静音，时段结束处截断。素材比时段长时一律在时段结束处截断。
  - `fade_in` 从时段起点起淡入；`fade_out` 以**实际出声结束点**为准结束——不循环且素材短于时段时，淡出落在
    素材播完处而不是时段末尾。
  - **`align = "source"`**：素材本身就是按源视频时间轴录的（典型是分离出来的人声 / 伴奏，或对着原片重配的口播），
    worker 先对它套用与源音轨完全相同的 `trim.remove`（atrim + concat），再按 `t` 时段截取、调音量、淡入淡出。
    此时 `offset` 必须为 0、`loop` 必须为 false；素材比源视频短时后段静音。编辑器预览同样按源时间定位。
  - 音量上限是 1（不能放大）：浏览器 `HTMLMediaElement.volume` 只到 1，这样编辑器预览能原样复现成片。
  - `asset_id` 对应的素材不存在、不是音频、还没 `ready`，或 `offset` 不小于素材时长时，worker 跳过该 track
    并在 job.error 里记警告（不失败）。track `id` 在同一 spec 内唯一。
  - 批量套用 `audio` 模块时整块深拷贝；`t` 基于剪后时间轴，不做裁剪（同图层）。
- **封面 `cover`**（可选，缺省 null，HIG-9）：在成片最前面插入一段封面，之后接剪辑后的正片。
  - 素材是 `type = "sticker"` 的图片或视频（含多帧 gif / webp）。图片封面停留 `duration` 秒（0.1–10，缺省 1.0）；
    视频封面整段播放一遍，时长取素材自身 `duration`，忽略 `duration` 字段。
  - **计时不变**：`trim.remove` 仍基于源时间轴，`layers[].t` 与 `audio.tracks[].t` 仍基于剪后（正片）时间轴，
    从正片第一帧起算。封面期间只有封面画面与封面声音，不叠图层、不放 BGM / 口播、不出源音轨。
    成片时长 = 封面时长 + 剪后时长。
  - **画面**：封面按输出变体的 `fill`（`blur` / `color` / `crop`）铺到画幅上；`crop` 窗口是源画面上的比例，
    对封面不生效（封面一律 cover 居中裁切）。帧率对齐到源视频。
  - **声音**：视频封面带音轨（`has_audio = true`）时原音量保留，不受 `source_volume` 影响；图片封面或无声视频
    封面期间静音。
  - 素材不存在、不是贴纸素材或还没 `ready` 时，worker 不插封面，在 job.error 里记警告（不失败）。
  - 编辑器预览同样先放封面再接正片；时间线上封面块排在正片之前。
  - 批量套用 `cover` 模块时整块深拷贝；源没有封面时目标的也被清掉。
- **文字 `style` 全部由前端渲染**进 `image_url` 的 PNG；后端只做 schema 校验并原样保存。`shadow`（`{ color, blur, offset: [x, y] }`，可为 null）、`glow`（`{ color, blur }`，无偏移的光晕，可为 null）、`letter_spacing`（em，可为负）、`background_width`、`background_radius` 以及图层级的 `spans` 都是可选字段，worker 不读取。`spans` 跟随 `text`（批量套用 `style_only` 时一起复制）。

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
- `POST /api/batches/{id}/apply` `{ source_video_id, target_video_ids: [], modules: ["trim"|"layers"|"outputs"|"audio"|"cover"], layer_mode?: "replace"|"style_only" }` → `Video[]`（被更新的目标）。规则：把源 spec 的对应模块深拷贝到目标；目标没有 spec 时先建空 spec；`trim` 模块套用时若目标时长更短，丢弃超出的区间；`audio` 模块整块深拷贝（源没有 `audio` 块时目标的也被清掉）；`cover` 模块同样整块深拷贝（源没有封面时清掉目标的）。
  - `layer_mode`（只影响 `layers` 模块，默认 `replace`）：
    - `replace`：目标的图层列表整体替换为源的深拷贝（原有行为）。
    - `style_only`：源图层逐个匹配目标图层——先按相同 `id`；文字图层没有 id 匹配时退而找第一个 `text` 完全相同的目标文字图层（每个目标图层最多被匹配一次）。匹配上的目标只覆盖类型相关字段（贴纸：`asset_id | playback | mix_audio`；文字：`text | spans | style | image_url | image_size`；遮盖：`mode | color | blur | height`）以及 `width | rotate | opacity`，保留目标自己的 `anchor | margin | t` 与其它键；没匹配上的源图层深拷贝追加到末尾——遮盖层例外，插到目标第一个文字图层之前（保持压在字幕之下）。目标没有图层时等价于 `replace`。
- `GET /api/batches/{id}/jobs` → `Job[]`（该批次全部任务，按创建时间倒序）
- `GET /api/batches/{id}/outputs` → `Job[]`（status = done，按视频 order、variant_key 排）
- `GET /api/outputs?limit=100&offset=0` → `Job[]`（**跨批次**，status = done，按 `finished_at` 倒序，缺 `finished_at` 时退回 `created_at`）。
  每项额外带上 `batch_name` 与 `video_name`。`limit` 默认 100、上限 500，`offset` 默认 0；越界返回空数组。

### 视频
- `GET /api/videos/{id}` → `Video`
- `PUT /api/videos/{id}/spec` `{ edit_spec }` → `Video`（服务端做 schema 校验，400 返回具体字段）
- `POST /api/videos/{id}/separate` `{ model?: "htdemucs" | "htdemucs_ft" }` → 202 `Video`（`separation.status = queued`）。
  视频未 `ready` 或没有音轨 400；已有 queued / running 的分离 409；队列不可用 503。完成后 `separation` 变 `done`
  并带两个素材 id；前端轮询 `GET /api/videos/{id}`。分离由独立的 `separator` worker（带 torch + Demucs 的镜像）
  执行；没有起这个 worker 时任务会一直停在 queued。
- `DELETE /api/videos/{id}` → 204（分离出来的素材不随视频删除，仍可在别的视频里用）

### 素材
- `GET /api/assets?type=sticker|font|audio&source=upload|builtin|library|derived` → `Asset[]`（两个参数都可选，缺省不过滤；非法值 400）
- `GET /api/assets/{id}` → `Asset` / 404（前端轮询视频贴纸 / 音频素材的 `preparing → ready`）
- `POST /api/assets` multipart：`type`，`files` → `Asset[]`。只产出 `source = "upload"` 的素材。
  - `sticker`：`png / jpg / jpeg / webp / gif` 与 `mp4 / mov / webm`（jpg 没有透明通道，主要给封面用）。**多帧的 gif / webp 与视频文件一样按视频贴纸处理**，
    立即入队预处理并以 `status = "preparing"` 返回。
  - `font`：`ttf / otf / woff2`
  - `audio`：`mp3 / wav / m4a`，入队探测时长并以 `status = "preparing"` 返回。
  - 单文件上限：图片 sticker 10 MiB、font 20 MiB、audio 50 MiB、视频 sticker 1 GiB，超出 400。视频贴纸与音频不限时长。
  - 请求头 `X-Upload-Ticket: <ticket>`（可选）：有效时本请求免 Cookie 校验，见下面的上传子域名。
- `POST /api/assets/upload-ticket` → `{ "upload_url": "https://hitgo-upload.example.com/api/assets" | null, "ticket": "..." | null, "expires_at": "..." | null }`。
  需要正常的访问码 Cookie。服务端未配置 `UPLOAD_BASE_URL` 时三个字段都是 null，前端照旧同源上传。
  配置了时签发一张 10 分钟有效的 ticket，前端把 `POST /api/assets` 直接发到 `upload_url`
  （跨域 XHR，带 `X-Upload-Ticket`，不带 Cookie）。
  **为什么**：主域名走 Cloudflare 代理，免费版单个请求超过 100 MB 会被 Cloudflare 回 413，根本到不了源站；
  上传子域名不经 Cloudflare 代理（DNS only），只放行这一个接口。服务端对 `PUBLIC_BASE_URL` 这个 origin
  开 CORS（`POST` / `OPTIONS`，允许 `X-Upload-Ticket`）。
- `DELETE /api/assets/{id}` → 204（一并删除 poster / preview 派生文件）。只有 `upload` 和 `derived` 的素材可删；
  `builtin` / `library` 不可删（400）——`builtin` 删了下次启动会被重新导入，`library` 归正式系统管。
- 素材的来源迁移规划（怎么把 `upload` / `builtin` 换成正式物料库的 `library`，要改哪几处）见 `docs/ASSETS.md`。

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
/data/assets/{asset_id}.poster.jpg            视频贴纸：首帧
/data/assets/{asset_id}.preview.{webm|mp4}    视频贴纸：浏览器可播的预览代理
/data/assets/{asset_id}.m4a                   分离出来的人声 / 伴奏（aac 192k，source = derived）
/data/uploads/{upload_id}.png
/data/outputs/{job_id}.mp4
/data/tmp/                                    worker 临时文件
```
`/media` 直接映射到 `DATA_DIR`（`hitgo.db` 和 `tmp/` 不对外）。

## 6. 预处理与渲染（worker）

### 素材预处理（视频贴纸入库后）
1. `ffprobe` 取宽高 / 时长 / 帧率；透明通道判定：VP8/VP9 看 stream tag `alpha_mode`，其它看首帧 `pix_fmt`
   是否是带 alpha 的像素格式（容器层的 `pix_fmt` 不可靠，HEVC-with-alpha 与 WebM-alpha 都报 `yuv420p`）。
2. 首帧 `{asset_id}.poster.jpg`。
3. 预览代理：带 alpha → `libvpx-vp9 -pix_fmt yuva420p` 出 `.webm`（音轨 `libopus 96k`）；否则
   `libx264 -pix_fmt yuv420p` 出 `.mp4`（音轨 `aac 128k`）。素材有音轨才带音轨（`-map 0:a:0?`），并记
   `has_audio`。预览代理只给编辑器看，渲染始终用原文件。
4. 服务启动时，`kind = video`、`status = ready` 但 `has_audio` 还是 null 的旧素材会重新入队预处理一次，补上
   `has_audio` 与带音轨的预览代理（素材保持 `ready`，不影响正在用它的 spec）。
5. 音频素材（`type = audio`）只做第 1 步的 `ffprobe`：取 `format.duration`，没有音频流则 `failed`；不生成任何派生文件。

### 人声 / 伴奏分离（`POST /api/videos/{id}/separate` 之后，独立的 separator worker）
1. `ffmpeg -i source -vn -ac 2 -ar 44100 -c:a pcm_s16le` 抽成 `/data/tmp/{video_id}.sep.wav`（超过 `SEPARATE_MAX_SECONDS`，缺省 600 秒，直接 failed）。
2. Demucs（CPU，`torch` 线程数 `SEPARATE_THREADS`，缺省 4）按 `model` 分成 drums / bass / other / vocals；
   人声轨 = vocals，伴奏轨 = 其余三路之和。
3. 两路各编码成 `{asset_id}.m4a`（`aac 192k`，44.1 kHz 立体声），建两条 `type = audio`、`source = derived`、
   `status = ready` 的素材（`duration` 取源视频时长），写回 `Video.separation`；上一次分离的两条素材连文件一起删掉。
4. 任何一步失败：`separation.status = failed` 并写 `error`，不产生素材。

### 预处理（每条视频入库后）
1. `ffprobe -v error -print_format json -show_format -show_streams`
2. 代理：`-vf "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)'" -c:v libx264 -preset veryfast -crf 28 -profile:v baseline -level 3.1 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart`
3. 雪碧图：`-vf "fps=1,scale=90:-2,tile=10x{rows}"`，rows = ceil(duration / 10)，记录 count/tile 尺寸
4. 封面：第 0.5 秒一帧 `poster.jpg`

### 渲染（每个 job）
1. 解析 spec，取输出画幅 W×H，读取图层素材 / PNG。
2. `filter_complex` 顺序：
   - 源 → `trim`/`atrim` 切保留段 → `concat`（无 remove 时跳过；无音轨时只处理视频）
   - 画幅：`blur` = `split` → 一路 `scale` 到 cover + `boxblur=20` + `crop=W:H`，另一路 `scale` 到 contain，`overlay` 居中；`color` = `scale` contain + `pad=W:H:(ow-iw)/2:(oh-ih)/2:color`；`crop` = （有 `crop` 窗口时先 `crop=w='iw*w':h='ih*h':x='iw*x':y='ih*y'`）→ `scale` cover + `crop=W:H`
   - 图层：按顺序 `[img]scale=w:-1,rotate=...:c=none:ow=rotw:oh=roth,format=rgba,colorchannelmixer=aa=opacity[li]`，`overlay=x:y:enable='between(t,a,b)'`（`t="all"` 不加 enable）
   - 遮盖层（`type = "mask"`）不加 `-i` 输入，直接作用在当前画布 `[c{n−1}]` 上，区域先裁到画布内（x, y, w, h 为整数像素）：
     - blur：`[c{n−1}]split=2[m{n}s][m{n}b]`；`[m{n}b]format=rgba,crop=w:h:x:y,boxblur=lr=R:lp=P[:enable='between(t,a,b)'][,colorchannelmixer=aa=opacity][m{n}x]`；
       `[m{n}s][m{n}x]overlay=x:y[:enable='between(t,a,b)'][c{n}]`。档位 1 / 2 / 3 → `R:P` = `10:1 / 20:2 / 40:3`，`R` 再收到 `min(w, h) // 2 − 1`
       （`boxblur` 要求半径小于短边的一半，收到 0 时跳过）。`format=rgba` 放在 `crop` 之前，避免 yuv420p 下奇数坐标被取偶。
     - solid：`[c{n−1}]drawbox=x=X:y=Y:w=W:h=H:color=0xRRGGBB[@opacity]:t=fill[:enable='between(t,a,b)'][c{n}]`。
     - 区域裁后不足 2×2 px 的遮盖跳过并记警告，不占用 `[c{n}]` 编号；成片里存在遮盖层不影响输出端的 `-t` 判断（它不是视频输入）。
   - 视频贴纸图层额外：输入侧 `playback = "loop"` 时加 `-stream_loop -1`，带透明的 WebM 还要强制解码器
     （VP9 → `-c:v libvpx-vp9`，VP8 → `-c:v libvpx`，否则 alpha 会被静默丢弃）；滤镜侧在链尾加
     `setpts=PTS-STARTPTS+a/TB`（贴纸从自己第 0 帧开始播）与 `trim=end=b`（既挡住无限循环，也挡住
     比主流长的素材）；`playback = "once"` 用 `overlay=...:eof_action=pass`，其余用 `repeat`。
   - 贴纸音轨：`mix_audio = true` 且素材 `has_audio = true` 的图层，从该输入取
     `[i:a]asetpts=PTS-STARTPTS,atrim=end=b−a,adelay=a·1000:all=1,aformat=48000/stereo`（loop 复用输入侧的
     `-stream_loop -1`），与主音轨（剪辑后的 `[at]` / 源 `0:a:0`；源无音轨时用 `anullsrc` 截到剪后时长）
     `amix=inputs=N:duration=first:normalize=0:dropout_transition=0` 混成 `[aout]` 再映射。没有这样的图层时
     命令与此前完全一致，贴纸音轨不映射。
   - 音轨 `audio`（第 2 节）：每条 track 一个 `-i` 输入（`loop = true` 时前置 `-stream_loop -1`），滤镜链
     `[i:a]atrim=start=offset,asetpts=PTS-STARTPTS,atrim=end=b−a,volume=v,afade=t=in:st=0:d=fade_in,`
     `afade=t=out:st=E−fade_out:d=fade_out,adelay=a·1000:all=1,aformat=48000/stereo`（各段按需省略；`E` = 实际出声长度：
     loop 时为 `b−a`，否则 `min(b−a, 素材时长−offset)`）。主音轨 `[abase]` = 剪辑后的源音轨接
     `aformat,volume=source_volume`；`source_volume = 0` 或源无音轨时改用 `anullsrc` 截到剪后时长。`[abase]`、
     贴纸音轨、各 track 多于一路时 `amix`（同上）成 `[aout]`；只有 `[abase]` 一路（只调了源音量）时直接映射它；
     `source_volume = 0` 且没有任何叠加音轨时 `-an`。存在 track 时输出端同样补 `-t <剪后时长>`。spec 没有 `audio`
     块时命令与此前完全一致。
   - `align = "source"` 的 track：输入侧不加 `-stream_loop`；先对 `[i:a]` 套用与源音轨相同的
     `atrim=start:end,asetpts` × 保留段 + `concat=n=N:v=0:a=1`（无剪辑时跳过），再 `atrim=start=a:end=b,asetpts=PTS-STARTPTS`
     截出时段，之后的 `volume / afade / adelay / aformat` 与普通 track 相同（`E` = `b−a`）。
   - 输出 `format=yuv420p`；本次渲染存在视频图层时，输出端补 `-t <剪后时长>` 兜底成片时长
   - 封面 `cover`（第 2 节）：以上正片画面接 `setsar=1,trim=end=剪后时长`，正片声音统一成一路带标签的
     `aformat=48000/stereo,apad,atrim=end=剪后时长`（原本直接映射 `0:a:0` 的也走这里；原本 `-an` 的改用
     `anullsrc` 截到剪后时长）。封面输入：图片 `-loop 1 -framerate <源 fps> -t N -i`，视频照常输入（带透明的
     WebM 同样强制解码器）；画面按同一 `fill` 铺满画幅（blur / color 同上，crop 不带窗口），接
     `fps=<源 fps>,setsar=1,format=yuv420p,trim=end=N,setpts=PTS-STARTPTS`；声音为视频封面的
     `[i:a]asetpts=PTS-STARTPTS,aformat,apad,atrim=end=N`，否则 `anullsrc` 截到 N。最后
     `[封面v][封面a][正片v][正片a]concat=n=2:v=1:a=1` 输出。成片总时长 = N + 剪后时长（进度与 `-t` 都用它）。
     spec 没有 `cover` 时命令与此前完全一致。
3. 编码（按输出变体的 `quality`，1080p）：
   - `standard`（默认）：`-c:v libx264 -preset veryfast -crf 20 -maxrate 8M -bufsize 16M -c:a aac -b:a 128k -movflags +faststart`
   - `high`：`-c:v libx264 -preset medium -crf 19 -maxrate 10M -bufsize 20M -c:a aac -b:a 128k -movflags +faststart`
4. 进度：`-progress pipe:1 -nostats`，解析 `out_time_us` / 成片总时长（剪后时长 + 封面时长）→ `progress`，每秒最多写库一次。
5. 完成：ffprobe 成片得到 duration / 宽高 / size，写 `output`、`callback`，状态 done；失败写 `error`（截取 ffmpeg stderr 最后 40 行）。

## 7. 运行方式

- 本地开发：`backend/` 用 `uv run uvicorn app.main:app --reload`（端口 8000），`frontend/` 用 `npm run dev`（Vite，`/api` 与 `/media` 代理到 8000）。
- 容器：单一镜像 `hitgo`（多阶段：node 构建前端 → python:3.12-slim + apt ffmpeg + uv），`api` 与 `worker` 两个服务共用；`redis:7-alpine`。API 同时托管前端静态文件（`/` → `frontend/dist`，SPA fallback）。
- 环境变量：`DATA_DIR`、`DATABASE_URL`、`REDIS_URL`、`ACCESS_CODE`、`PUBLIC_BASE_URL`、`WORKER_CONCURRENCY`（默认 1）、`UPLOAD_BASE_URL`（可选，上传子域名，如 `https://hitgo-upload.mrlgs.net`；空 = 不启用）。
- 服务器：`docker compose` 监听 `127.0.0.1:8790`，nginx `hitgo.mrlgs.net` 反代，见 `docs/DEPLOY.md`。
