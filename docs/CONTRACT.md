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
  "localization": null,           // 可选；改语言状态（听写模板 + 各语言配音版本），见下；null = 从未生成
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

**改语言 `localization`**（可选，缺省 null）：把源视频的口播听写成一份**模板**（源语言逐句文本 + 时间），再按目标
语言各派生一个**版本**（译文 + 合成配音）。配音是 `type = "audio"`、`source = "derived"`、`derived_from.stem = "dubbed"`
的素材，前端用 `audio.tracks[]`（`align = "source"`、`role = "voice"`）套用，译文字幕用文字图层套用：

```jsonc
{
  "source_lang": "en",              // 听写用的源语言；请求 "auto" 时为识别结果（模型没报语言则仍是 "auto"）
  "transcript": {                   // 模板：听写一次，可人工修正
    "status": "done",               // queued | running | done | failed
    "error": null,                  // failed 时的中文原因
    "cues": [ { "i": 0, "start": 0.42, "end": 2.91, "text": "Welcome to HitGO." } ],   // 秒，基于源时间轴
    "updated_at": "..."
  },
  "versions": {                     // 按目标语言一份，互相独立；键 = 语言码
    "ko": {
      "status": "done",             // queued | running | done | failed
      "stage": null,                // running 时 translate | tts | mix；queued 且 = "tts" 表示只重新合成（不重译）
      "voice": "loongkyong_v3",     // 合成用的音色 id（见 GET /api/localize/options）
      "terms": [ { "source": "HitGO", "target": "힛고" } ],   // 翻译术语表
      "cues": [ { "i": 0, "translated": "힛고에 오신 것을 환영합니다." } ],   // 与 transcript.cues 按 i 对齐
      "stale": false,               // 模板改过之后为 true：译文不是最新模板译出来的，需重译
      "error": null, "warnings": [],   // warnings：配音塞不进原句时段等提示
      "voice_asset_id": "a_d0bb3d", // done 才有：配音素材，derived_from = { video_id, video_name, stem: "dubbed", lang: "ko" }
      "updated_at": "..."
    }
  }
}
```

`transcript.cues[].start / end` 基于**源时间轴**，前端要经 `trim.remove` 换算到剪后时间轴再生成字幕图层；版本
`cues` 只有译文，按 `i` 对齐模板。一条视频同一时间只能「套用」一个语言版本（一份 `edit_spec`）；切换版本 =
把旧的 `origin = "localize"` 层 / 轨换成新的。配音只含人声（其余静音），背景音乐由前端另加分离出的伴奏轨。

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
  "derived_from": null,           // 可选；source = derived 才有：{ "video_id", "video_name", "stem": "vocals" | "instrumental" | "dubbed", "lang"? }（lang 只在 dubbed 时有，如 "ko"）
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

**配音**（`source = "derived"`，`derived_from.stem = "dubbed"`）：由改语言产生，每个语言版本一条（`derived_from.lang`
是语言码），`type = audio`、`kind = audio`、`status = ready`，时长等于源视频，内容是按源时间轴铺好的合成人声（其余
静音）。重新合成同一语言会换新 id 并删掉旧素材（连文件）；`DELETE …/localize/versions/{lang}` 也会删掉它。

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
  "output": null,                 // done 时：{ "width", "height", "duration", "size", "codec": "h264/aac", "audio"? }（audio 见下）
  "callback": null,               // done 时：第 4 节的回传 JSON（原型只展示，不真正发送）
  "created_at": "...", "started_at": null, "finished_at": null,
  "name": null,                   // 导出时填的名称（POST /api/render 的 name），没填为 null
  "batch_name": null,             // 只有跨批次的 GET /api/outputs 会填；其余端点为 null
  "video_name": null              // 同上
}
```

`name` 是一次导出共用的名称，同一次 `POST /api/render` 建出的所有任务带同一个值；前端下载时用它拼文件名
（`名称_视频名_规格.mp4`，没有名称时用批次名），并可在 `GET /api/outputs?q=` 里搜到。

`batch_name` / `video_name` 是给跨批次列表用的冗余字段：`GET /api/outputs` 一次返回来自不同批次的
任务，调用方没法像单批次页面那样再拉一次 `GET /api/batches/{id}` 去查名字。其余返回 `Job` 的端点
一律为 `null`，调用方仍从批次详情里取名。

`output.audio`（可选，HIG-26）：spec 带 `audio` 块时，worker 记下这次成片**实际**混进了什么，产物页据此显示
「音轨：…」，一眼能对上成片里该有的声音。旧任务、以及 spec 没有 `audio` 块的任务没有这个字段。

```jsonc
"audio": {
  "source_volume": 0,                        // 同 spec；源视频没有音轨时为 0
  "source_mute": 1,                          // source_mute 时段个数
  "tracks": [                                // 真正进了混音的 track，顺序同 spec
    { "id": "au_1", "asset_id": "a_bgm001", "name": "口播.mp3", "role": "voice" }
  ],
  "skipped": ["au_2"]                        // 被跳过的 track id（原因同时写在 job.error 的警告里）
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
      "t": [0, 6],                           // 出现时段，秒，基于剪后时间轴；"all" 表示全程
      "hidden": false,                       // 可选，缺省 false：编辑器里关掉眼睛，留在 spec 里但成片不出（HIG-33，所有图层类型通用）
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
      "variant_images": {                    // 可选（HIG-29）：按某个输出重新渲染的 PNG，键为 variant_key，见下方规则
        "1x1": { "url": "/media/uploads/u_7h6g.png", "size": [304, 73] }
      },
      "anchor": "top-center", "margin": [0, 0.06],
      "width": 0.5,                          // 相对画布宽；PNG 按此缩放
      "rotate": 0, "opacity": 1, "t": "all",
      "animation": {                         // 可选（HIG-40）：入场 / 出场 / 循环动画，三项各自可选，见下方规则
        "in": { "preset": "pop", "duration": 0.5 },
        "out": { "preset": "fade", "duration": 0.5 },
        "loop": { "preset": "breathe", "period": 1.2 }
      },
      "origin": "localize", "lang": "ko"     // 可选；前端标记：改语言套用出来的译文字幕（见下方规则）
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
    { "variant_key": "9x16", "aspect": "9:16", "fill": "blur", "quality": "high",
      "export": true },                      // 可选（HIG-35）：导出时是否勾选这个画幅；缺省时 9x16 视为 true、其余视为 false，见下方规则
    { "variant_key": "1x1",  "aspect": "1:1",  "fill": "blur",
      "layer_fit": "video",                  // 可选，缺省 "canvas"：图层相对该画布 | "video"：跟着视频画面走，见下方规则
      "layer_overrides": { "l_1": { "margin": [0.05, 0.05], "width": 0.3 } } },
    { "variant_key": "4x5",  "aspect": "4:5",  "fill": "crop",
      "crop": { "x": 0.3418, "y": 0, "w": 0.3164, "h": 1 } }   // 可选：源画面上的裁切窗口，见下方规则
  ],
  "audio": {                                 // 可选；缺省 = 源音轨原样保留（即此前的行为）
    "source_volume": 1,                      // 0–1；0 = 源音轨静音（相当于剪映「分离音频 → 删除」）
    "source_mute": [[3.0, 4.5]],             // 可选，缺省 []：源音轨在这些时段静音（剪后时间轴，秒），画面不动（HIG-25）
    "source_hidden": false,                  // 可选，缺省 false：源音轨关掉眼睛，成片不带原声，source_volume 原样保留（HIG-33）
    "tracks": [
      {
        "id": "au_1",
        "asset_id": "a_bgm001",              // Asset.type = "audio"
        "role": "bgm",                       // 可选，缺省 "bgm"：bgm | voice，只给界面分类，worker 不区分
        "t": "all",                          // 出声时段，秒，基于剪后时间轴；同 layers[].t
        "align": "post",                     // 可选，缺省 "post"：post = 素材从时段起点开始播 | source = 素材对齐源时间轴（分离出的人声 / 伴奏用），见下方规则
        "offset": 0,                         // 可选，缺省 0：从素材第几秒开始播；loop = true 时是第一遍的起点
        "volume": 1,                         // 可选，缺省 1：0–1
        "loop": false,                       // 可选，缺省 false：素材短于时段时循环；false 播完即静音
        "fade_in": 0, "fade_out": 0,         // 可选，缺省 0：秒；两者之和不能超过时段长
        "hidden": false,                     // 可选，缺省 false：关掉眼睛，不混进成片（HIG-33）
        "origin": "localize", "lang": "ko"   // 可选；前端标记：改语言套用出来的配音轨（见下方规则）
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
- **编辑器里的多画幅**（HIG-29，取代 HIG-8 的「只出 9x16」）：`outputs` 保存「已配置的画幅」，`9x16` 始终存在并排第一，其余按 `9x16 / 1x1 / 4x5 / 16x9` 排；导出时在导出对话框勾选这次出哪些画幅（`POST /api/render` 的 `variant_keys`），勾选到但 spec 里还没有的画幅按缺省（`fill = "blur"`、`quality` 随 `9x16`、`layer_fit = "video"`）补上再保存。取消勾选不会删掉已配置画幅的设置。勾选结果写进各输出的 `export`（HIG-35，可选布尔；缺省时 `9x16` 视为勾选、其余视为不勾），「成片画面」画幅页签上的勾与导出对话框是同一份，随视频保存；worker 不读 `export`，这次出哪些文件仍只由 `variant_keys` 决定。载入时没有 `layer_fit` 的非 `9x16` 输出（HIG-8 之前的旧 spec）改成 `"video"` 并清掉其 `layer_overrides`（旧覆盖按画布相对写，语义已变）。
- **`layer_fit`**（可选，缺省 `"canvas"`）：非 `9x16` 输出上图层怎么摆。`"canvas"` = 上面的公式直接套该输出的画布（此前的行为）；`"video"` = 图层跟着视频画面走：
  - **参考画布**：spec 里 `variant_key = "9x16"` 的输出（没有时按 `9:16` + `blur`）。图层的 `anchor / margin / width / height` 都按参考画布理解。参考输出自身、以及源视频宽高未知时忽略此字段，按 `"canvas"` 处理。
  - **映射**：分别算出源画面在参考画布与目标画布上的位置（`blur` / `color`：contain 居中；`crop`：先取裁切窗口再 cover 居中），得到「参考画布像素 → 源像素 → 目标画布像素」的等比映射 `p' = offset + p·k`。
  - **遮盖层**：参考画布上的矩形整体过映射（`w·k`、`h·k`），对准烧进画面的原字幕；映射后被裁出画布的遮盖静默跳过，不写警告。模糊档位的像素半径不跟着缩放。
  - **文字 / 贴纸**：可见视频区域 V = 映射后的参考画布与目标画布的交集；宽 = `width · 参考宽 · min(k, 1)`（cover 放大时不放大图层），位置按上面的锚点公式在 V 里算（`margin` 相对 V 的宽 / 高），最后整体平移回画布内。`blur` / `color` 时这与直接映射参考矩形等价。
  - **与 `layer_overrides` 的合并**：某图层的覆盖里只要出现 `anchor / margin / width / height` 任一项，它在这个输出上就不再跟随，几何完全按 `"canvas"` 语义（覆盖值优先，缺的回落到图层自身值，相对目标画布）；`rotate / opacity` 各自单独覆盖，不影响是否跟随。
  - **文字按输出重新渲染 `variant_images`**（文字图层可选字段）：`{ [variant_key]: { url, size: [w, h] } }`，`url` 同 `image_url` 必须是 `/media/` 站内路径，`size` 为正整数。worker 渲染某个输出时优先用该输出的 PNG，文件找不到时静默回落到 `image_url`；几何（位置、`width·W` 的宽度）不受影响，PNG 只决定清晰度。前端每次导出按各输出上文字的实际像素宽相对 `image_size` 的倍率重新生成（倍率与 1 相差不到 2% 的输出不单独生成，相近倍率共用一张），旧的整份替换。批量套用 `style_only` 时随文字一起复制。
  - 前端 `lib/variantLayout.ts` 与后端 `services/layout.py` 同一套规则，两端共用 `frontend/src/lib/fixtures/variantLayoutCases.json` 做 golden 测试。
- **输出质量**：`quality`：`standard`（默认，省略即 standard）| `high`；决定第 6 节的编码档位，每个输出变体独立设置。
- `layer_overrides` 只允许覆盖 `anchor | margin | width | height | rotate | opacity`（`height` 只对遮盖层有意义，其它类型忽略）。
- **遮盖层 `type = "mask"`**：把画布上的一块矩形区域模糊或盖上色块，典型用途是遮住烧进画面的原字幕再叠新字幕；不需要任何素材。
  - 位置换算同其它图层，`h = height·H`（`height` 缺省 0.12，(0, 1]）；`rotate` 忽略。超出画布的部分裁掉，剩余不足 2×2 px 时 worker 跳过该图层并在 job.error 里记警告（不失败）。
  - `mode = "blur"`（缺省）：区域模糊，`blur` 档位 1 / 2 / 3 = `boxblur=10:1 / 20:2 / 40:3`，半径自动收到 `min(w, h) / 2 − 1`（收到 0 时跳过并记警告）；`opacity` 是模糊层按透明度叠回原画面的比例。
  - `mode = "solid"`：用 `color`（`#RRGGBB`）盖住区域，`opacity` 是色块的 alpha。
  - 层级按 `layers` 数组顺序：编辑器新建 / 粘贴遮盖层时插到第一个文字图层之前，所以遮盖永远压在字幕之下；用户仍可在同类里调层级。
  - 批量套用 `style_only` 时复制 `mode | color | blur | height`（+ 公共的 `width | rotate | opacity`），未匹配的遮盖层插到目标第一个文字图层之前而不是追加到末尾。
  - 编辑器预览用 `backdrop-filter` 模糊 / 色块 div 实时叠在画面上，只是近似；成片效果以 worker 为准。遮盖只是模糊 / 色块，不是无痕擦除。
- **隐藏 `hidden`**（HIG-33，图层 / 音轨可选，缺省 `false`；源音轨用 `audio.source_hidden`）：编辑器轨道头的「眼睛」。
  隐藏不是删除，所有设置都留在 spec 里，打开眼睛即恢复。worker 对 `hidden = true` 的图层当作不存在（贴纸的
  `mix_audio` 声音一并去掉），不写警告；`hidden = true` 的 track 不混入，也不计入回传 `audio.skipped`；
  `source_hidden = true` 等价于 `source_volume = 0`（回传的 `audio.source_volume` 为 0），但 spec 里的 `source_volume`
  不变。编辑器预览按同样的规则隐藏 / 静音。前端只在为 `true` 时发送这些字段。批量套用时随所在的图层 / `audio`
  块一起复制（`style_only` 匹配上的目标保留自己的 `hidden`）。
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
  - 每条 track 只在 `t` 时段内出声，从素材的第 `offset` 秒起；`loop = true` 时第一遍从 `offset` 播到素材末尾，
    之后从头循环（HIG-25 起允许 `offset > 0`，拆分循环轨时后半段靠它接着放），`false` 时播完即静音，时段结束处截断。
    素材比时段长时一律在时段结束处截断。
  - `fade_in` 从时段起点起淡入；`fade_out` 以**实际出声结束点**为准结束——不循环且素材短于时段时，淡出落在
    素材播完处而不是时段末尾。
  - **`align = "source"`**：素材本身就是按源视频时间轴录的（典型是分离出来的人声 / 伴奏，或对着原片重配的口播），
    worker 先对它套用与源音轨完全相同的 `trim.remove`（atrim + concat），再按 `t` 时段截取、调音量、淡入淡出。
    此时 `offset` 必须为 0、`loop` 必须为 false；素材比源视频短时后段静音。编辑器预览同样按源时间定位。
  - 音量上限是 1（不能放大）：浏览器 `HTMLMediaElement.volume` 只到 1，这样编辑器预览能原样复现成片。
  - `asset_id` 对应的素材不存在、不是音频、还没 `ready`，或 `offset` 不小于素材时长时，worker 跳过该 track
    并在 job.error 里记警告（不失败）。track `id` 在同一 spec 内唯一。
  - **`source_mute`**（可选，缺省 `[]`，HIG-25）：源音轨（× `source_volume` 之后）在这些时段内静音，时段基于剪后
    时间轴，升序、不重叠、起点 ≥ 0、终点 > 起点；超出剪后时长的部分忽略。只影响源音轨：画面、贴纸音轨、各 track
    不受影响，后面的声音也不前移（音画保持同步）。编辑器里「剪掉一段原声」就是往这里加一个时段。
  - **拆分音轨**（HIG-25）是纯前端操作：一条 track 在剪后时刻 `p` 拆成两条 `t` 相接的 track，后一条换新 `id`；
    `align = "post"` 的后一条 `offset` 顺延 `p − a`（循环轨对素材时长取模），`align = "source"` 的只拆 `t`。
    不引入新字段，worker 照常逐条混音。
  - 批量套用 `audio` 模块时整块深拷贝；`t` 与 `source_mute` 基于剪后时间轴，不做裁剪（同图层）。
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
- **改语言标记 `origin` / `lang`**（可选）：`layers[]` 与 `audio.tracks[]` 上的前端标记，`origin = "localize"` 表示这一层 / 轨
  是套用某个语言版本生成的，`lang` 是语言码。worker 忽略这两个字段（`extra = "ignore"` 校验但原样存取），批量套用
  原样复制；前端靠它们在切换版本时替换旧层 / 轨、判断当前套用的是哪个版本。
- **文字动画 `animation`**（文字图层可选，HIG-40）：`{ in?, out?, loop? }`，缺省 / 空对象 = 不动（命令与此前完全一致）。
  - `in` / `out`：`{ preset, duration }`，`preset` ∈ `fade | slide_up | slide_down | slide_left | slide_right | pop`，`duration` 秒，(0, 10]，缺省 0.5。
    `loop`：`{ preset, period }`，`preset` ∈ `breathe | float | blink`，`period` 秒，[0.2, 10]，缺省 1.2。
  - 时间相对图层的出现时段 `[a, b]`（`t = "all"` 时为 `[0, 剪后时长]`，终点裁到剪后时长），本地时间 `u = 时刻 − a`，`L = b − a`。
    入场占 `[0, di]`，`di = min(in.duration, L)`；出场占 `[L − do, L]`，`do = min(out.duration, L − di)`；循环从 `di` 持续到 `L`（与出场叠加）。
    `t` 为区间时 `in.duration + out.duration` 不能超过 `L`（400）；编辑器保存前按上面的规则把两者压进时段。
  - 每一帧是四个量：透明度倍数 `opacity`（乘在图层 `opacity` 上）、中心偏移 `dx / dy`（**相对画布高**，各画幅看起来一样）、绕中心缩放 `scale`。各项相乘 / 相加：
    - 入场，`p = clip(u/di, 0, 1)`，`e = 1 − (1 − p)³`：`fade` 透明度 `e`；`slide_up` 另 `dy = 0.05·(1 − e)`（从下方滑上来），`slide_down` `dy = −0.05·(1 − e)`，
      `slide_left` `dx = 0.05·(1 − e)`（从右侧滑向左），`slide_right` `dx = −0.05·(1 − e)`；`pop` 透明度 `clip(3p, 0, 1)`、`scale = 0.5 + 0.5·back(p)`，
      `back(p) = 1 + 2.70158·(p − 1)³ + 1.70158·(p − 1)²`（略微回弹）。
    - 出场，`q = clip((u − (L − do))/do, 0, 1)`，`e = q³`：透明度 `1 − e`；`slide_up` `dy = −0.05·e`，`slide_down` `dy = 0.05·e`，`slide_left` `dx = −0.05·e`，
      `slide_right` `dx = 0.05·e`；`pop` `scale = 1 − 0.5·e`；`fade` 只有透明度。
    - 循环（`di ≤ u ≤ L`），`w = 2π·(u − di)/period`：`breathe` `scale × (1 + 0.03·(1 − cos w))`；`float` `dy − 0.008·sin w`；`blink` 透明度 × `(1 − 0.35·(1 − cos w))`。
  - 前端 `lib/textAnimation.ts` 与后端 `services/animation.py` 同一套公式，两端共用 `frontend/src/lib/fixtures/textAnimationCases.json` 做 golden 测试。
    编辑器画布按同一曲线预览；选中文字且暂停时显示静止状态（方便拖动调整）。批量套用 `style_only` 时随文字一起复制。
- **文字 `style` 全部由前端渲染**进 `image_url` 的 PNG；后端只做 schema 校验并原样保存。`shadow`（`{ color, blur, offset: [x, y] }`，可为 null）、`glow`（`{ color, blur }`，无偏移的光晕，可为 null）、`letter_spacing`（em，可为负）、`background_width`、`background_radius` 以及图层级的 `spans` 都是可选字段，worker 不读取。`spans` 跟随 `text`（批量套用 `style_only` 时一起复制）。

## 3. API

### 认证
- `GET /api/auth` → `{ required, ok }`
- `POST /api/auth` `{ code }` → 200 设 Cookie / 401

### 批次
- `GET /api/batches` → `Batch[]`（按创建时间倒序）
- `POST /api/batches` `{ name }` → `Batch`
- `GET /api/batches/{id}` → `Batch & { videos: Video[] }`
- `PATCH /api/batches/{id}` `{ name }` → `Batch`（改名；`name` 去掉前后空白后 1–255 字符，否则 400；不存在 404）
- `DELETE /api/batches/{id}` → 204（删除视频、任务、文件）
- `POST /api/batches/{id}/videos` multipart，字段 `files`（多文件，mp4 / mov）→ `Video[]`，每条立即入队预处理。
  已有视频的批次也可以再调用来追加，新视频排在末尾（`order_index` 接着现有数量）。
- `POST /api/batches/{id}/apply` `{ source_video_id, target_video_ids: [], modules: ["trim"|"layers"|"outputs"|"audio"|"cover"], layer_mode?: "replace"|"style_only" }` → `Video[]`（被更新的目标）。规则：把源 spec 的对应模块深拷贝到目标；目标没有 spec 时先建空 spec；`trim` 模块套用时若目标时长更短，丢弃超出的区间；`audio` 模块整块深拷贝（源没有 `audio` 块时目标的也被清掉）；`cover` 模块同样整块深拷贝（源没有封面时清掉目标的）。
  - `layer_mode`（只影响 `layers` 模块，默认 `replace`）：
    - `replace`：目标的图层列表整体替换为源的深拷贝（原有行为）。
    - `style_only`：源图层逐个匹配目标图层——先按相同 `id`；文字图层没有 id 匹配时退而找第一个 `text` 完全相同的目标文字图层（每个目标图层最多被匹配一次）。匹配上的目标只覆盖类型相关字段（贴纸：`asset_id | playback | mix_audio`；文字：`text | spans | style | image_url | image_size | variant_images | animation`；遮盖：`mode | color | blur | height`）以及 `width | rotate | opacity`，保留目标自己的 `anchor | margin | t` 与其它键；没匹配上的源图层深拷贝追加到末尾——遮盖层例外，插到目标第一个文字图层之前（保持压在字幕之下）。目标没有图层时等价于 `replace`。
- `GET /api/batches/{id}/jobs` → `Job[]`（该批次全部任务，按创建时间倒序）
- `GET /api/batches/{id}/outputs` → `Job[]`（status = done，按视频 order、variant_key 排）
- `GET /api/outputs?limit=100&offset=0&q=` → `Job[]`（**跨批次**，status = done，按 `finished_at` 倒序，缺 `finished_at` 时退回 `created_at`）。
  每项额外带上 `batch_name` 与 `video_name`。`limit` 默认 100、上限 500，`offset` 默认 0；越界返回空数组。
  `q` 可选：去掉前后空白后非空时，只返回任务 `name`、批次名或视频名包含它（不区分大小写）的产物；分页作用在过滤之后。

### 视频
- `GET /api/videos/{id}` → `Video`
- `PATCH /api/videos/{id}` `{ name }` → `Video`（改显示名，不动源文件；`name` 规则同批次改名）
- `PUT /api/videos/{id}/spec` `{ edit_spec }` → `Video`（服务端做 schema 校验，400 返回具体字段）
- `POST /api/videos/{id}/separate` `{ model?: "htdemucs" | "htdemucs_ft" }` → 202 `Video`（`separation.status = queued`）。
  视频未 `ready` 或没有音轨 400；已有 queued / running 的分离 409；队列不可用 503。完成后 `separation` 变 `done`
  并带两个素材 id；前端轮询 `GET /api/videos/{id}`。分离由独立的 `separator` worker（带 torch + Demucs 的镜像）
  执行；没有起这个 worker 时任务会一直停在 queued。
- `POST /api/videos/{id}/localize` `{ source_lang?: "auto", target_langs: ["ko","ja"], voices?: { ko: "loongkyong_v3" }, terms?: [{ source, target }], retranscribe?: false }`
  → 202 `Video`。一个任务：`transcript` 不是 `done`（或 `retranscribe`）就先听写，再对每个目标语言依次 翻译 → 合成 → 混音，
  每个版本独立 done / failed。`source_lang` 只在听写时生效；`target_langs` 1–5 个且必须在 options 的 `target_langs` 里，
  `voices` 缺省取该语言第一个音色。视频未 `ready` / 没有音轨 / 不支持的语言或音色 400；`transcript` 或任一请求的版本
  正在 queued / running 409；没配 `DASHSCOPE_API_KEY` 或队列不可用 503（状态回滚）。前端轮询 `GET /api/videos/{id}`。
- `PUT /api/videos/{id}/localize/transcript` `{ cues: [{ i, text }], source_lang? }` → 200 `Video`。修正模板文本（只传改动的句子），
  不触发任务；所有已有译文的版本 `stale = true`，之后对该语言再 `POST` 即重译。还没有听写结果 400；有版本正在生成 409。
- `PUT /api/videos/{id}/localize/versions/{lang}` `{ cues: [{ i, translated }], voice? }` → 202 `Video`。改译文 / 换音色后只重跑
  合成 + 混音（`stage = "tts"`，不重译）。`cues` 可为空但此时必须带 `voice`；该版本没有译文 400；进行中 409；503 同上。
- `DELETE /api/videos/{id}/localize/versions/{lang}` → 204，删掉该语言版本及其配音素材；没有这个版本 404；进行中 409。
- `GET /api/localize/options` → `{ enabled, source_langs: [{ code, label }], target_langs: [{ code, label, rtl, voices: [{ id, label }] }] }`。
  `rtl`（可选，缺省 false）= 该语言从右到左书写（阿拉伯语等）。
  `enabled = false`（没配 key）时前端禁用模块并提示；语言与音色一律以此为准，前端不写死。`source_langs` 含 `auto`。
- `DELETE /api/videos/{id}` → 204（分离出来的素材与配音不随视频删除，仍可在别的视频里用）。
  该视频有 queued / running 的渲染任务时 409（worker 还会往它的路径写文件），等任务结束再删。

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
- `POST /api/render` `{ video_ids: [], name?: string, variant_keys?: string[] }` → `Job[]`。`name` 可选，去掉前后空白后最多 120 字符（超出 400），空串视为没填；写到本次建出的每个任务的 `name`。每个视频按其 spec 的 `outputs` 生成任务；`variant_keys`（HIG-29，可选，非空）只为这些输出建任务，某个视频的 spec 里没有其中某个 key 时整单 400，缺省 = 全部输出。已有 queued / running 任务的同一 video+variant 不重复建（409 列出冲突，只检查本次要建的 key）。
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

Job 完成时生成并存到 `job.callback`，产物页按批次筛选（`/outputs?batch=<id>`）时展示：

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
/data/assets/{asset_id}.m4a                   分离出来的人声 / 伴奏、改语言配音（aac 192k，source = derived）
/data/uploads/{upload_id}.png
/data/outputs/{job_id}.mp4
/data/tmp/                                    worker 临时文件
/data/tmp/{video_id}.loc/                     改语言运行中的临时目录（16 kHz wav、逐句配音片段），结束即删
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

### 改语言（`POST /api/videos/{id}/localize` 之后，普通 worker，纯网络调用）
全部走阿里云百炼（`DASHSCOPE_API_KEY`），不吃本机算力；任务 `hitgo.localize_video` 在默认队列，软超时
`LOCALIZE_TIMEOUT_SECONDS`（缺省 900 秒），超时后进行中 / 排队中的版本记 failed。任务开始时把所有 `queued` 的版本都
接下来做，写回时只改自己负责的模板 / 版本，所以任务运行期间 `POST` 加的语言、`DELETE` 掉的别的版本都不会被覆盖。
1. **听写一次**（`transcript` 不是 done 或 `retranscribe`）：`ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le` 抽成
   `/data/tmp/{video_id}.loc/asr.wav`（没有音轨、或超过 `LOCALIZE_MAX_SECONDS`（缺省 600 秒）直接 failed），
   `paraformer-realtime-v2` 逐句给出毫秒起止；`source_lang = auto` 时不传语言提示、取识别到的语言。去掉空句、裁到
   源时长、最多 400 句，写成 `transcript.cues`（源时间轴）；一句都没有则 failed。听写失败时本次请求的所有版本一并 failed；
   重新听写后所有已有版本 `stale = true`。
2. **每个目标语言**（`stage` 依次 `translate → tts → mix`，各版本独立 done / failed）：
   - translate：整段按 `1. …\n2. …` 编号送 `qwen-mt-plus`（语言用英文全名，任意配对直译不经英语中转，带 `terms`）；
     回来的编号对不上就逐句重译一遍。`stage = "tts"` 排队的版本跳过这一步，直接用已有译文。
   - tts：每句用版本的 `voice` 出 wav。音色各自属于某个 TTS 模型：中 / 英 / 日 / 韩 / 粤 / 印尼用 `cosyvoice-v3-flash`（每句一个新实例），
     西 / 葡 / 法 / 德 / 意 / 俄用 `qwen3-tts-flash`（HTTP 调用，返回 24 小时有效的 wav 地址，worker 立即下载；这个模型没有语速参数，
     超长只靠下一步的 `atempo`）；`LOCALIZE_VOICES` 里 `lang=voice@model` 可给任意语言指定音色和模型。译文常比原句长（韩语约为英文 2 倍），
     一句配音超过它到下一句起点的间隔时，按比例用 `speech_rate`（上限 2.0）加速重合成一次，剩余再交给下一步的 `atempo`。
   - mix：每句放在模板里该句的源起点；配音比到下一句起点的间隔长时 `atempo` 加速，上限 `LOCALIZE_MAX_TEMPO`（缺省 1.3），
     仍超出则保留重叠并写进 `warnings`。一条 ffmpeg：`anullsrc` 静音底（源时长）+ 每句 `adelay` + `amix normalize=0`
     → `{asset_id}.m4a`（aac 192k，44.1 kHz 立体声），建一条 `type = audio`、`source = derived`、`stem = dubbed` 的素材，
     `stale = false`，上一次这个语言的配音素材连文件一起删掉。
3. 临时目录 `tmp/{video_id}.loc/` 结束即删；`LOCALIZE_PROVIDER = fake` 时三步都用假实现（静音配音），只给测试 / 演示。

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
   - 带 `animation` 的文字图层（第 2 节）：输入改为 `-loop 1 -framerate <fps> -t <b> -i <png>`（从 0 起逐帧，滤镜时间 = 成片时间）；
     链路 `format=rgba,scale=w:h` →（`scale` 动时）`pad` 到 1.1 倍留出余量 + `perspective=x0..y3=中心 ± 半宽/半高·scale((in−1)/fps − a):sense=destination:eval=frame`
     （滤镜链路不能逐帧改尺寸，所以用透视搬角点代替缩放；`in` 从 1 计数）→ `rotate`（同静态）→（`opacity` 动时）
     `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)·opacity·anim(T − a)'` 代替 `colorchannelmixer`；`overlay` 的 x / y 在动时写成
     `x0 + H·dx(t − a)` 表达式，`enable` 照旧。不动的通道保持静态写法；没有 `animation` 的图层命令不变。
   - `hidden = true` 的图层 / track 在构图前直接跳过，`source_hidden = true` 按 `source_volume = 0` 处理（第 2 节）。
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
     `aformat,volume=source_volume`（有 `source_mute` 时先 `asetpts=PTS-STARTPTS`，再每段追加
     `volume=0:enable='between(t,a,b)'`）；`source_volume = 0` 或源无音轨时改用 `anullsrc` 截到剪后时长。`[abase]`、
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
5. 完成：ffprobe 成片得到 duration / 宽高 / size，写 `output`（spec 带 `audio` 时附 `output.audio`，见第 1 节 Job）、`callback`，状态 done；失败写 `error`（截取 ffmpeg stderr 最后 40 行）。

## 7. 运行方式

- 本地开发：`backend/` 用 `uv run uvicorn app.main:app --reload`（端口 8000），`frontend/` 用 `npm run dev`（Vite，`/api` 与 `/media` 代理到 8000）。
- 容器：单一镜像 `hitgo`（多阶段：node 构建前端 → python:3.12-slim + apt ffmpeg + uv），`api` 与 `worker` 两个服务共用；`redis:7-alpine`。API 同时托管前端静态文件（`/` → `frontend/dist`，SPA fallback）。
- 环境变量：`DATA_DIR`、`DATABASE_URL`、`REDIS_URL`、`ACCESS_CODE`、`PUBLIC_BASE_URL`、`WORKER_CONCURRENCY`（默认 1）、`UPLOAD_BASE_URL`（可选，上传子域名，如 `https://hitgo-upload.mrlgs.net`；空 = 不启用）。
- 服务器：`docker compose` 监听 `127.0.0.1:8790`，nginx `hitgo.mrlgs.net` 反代，见 `docs/DEPLOY.md`。
