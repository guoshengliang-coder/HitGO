# 素材（贴纸 / 字体）与迁移规划

原型阶段的素材由使用者从本机手动上传，文件落在 `DATA_DIR/assets/` 下。这份文档回答一个问题：
**将来把素材换成公司正式的物料库 / 资源库时，要改哪些地方、不用改哪些地方。**

契约里的字段定义见 `docs/CONTRACT.md` §1 Asset 与 §3 素材。

## 1. 三种来源

`Asset.source` 有三个值，语义和生命周期各不相同：

| source | 谁创建 | 文件在哪 | 谁能删 |
|---|---|---|---|
| `upload` | 使用者在「素材库」页上传（`POST /api/assets`） | `DATA_DIR/assets/{asset_id}.{ext}` | 使用者，`DELETE /api/assets/{id}` |
| `builtin` | 后端启动时从仓库的 `samples/stickers`、`samples/fonts` 导入（`app/main.py` 的 `seed_builtin_assets`，`SAMPLES_DIR=-` 可关闭） | 同上，启动时复制一份进去 | 谁都不能。删了下次启动会被重新导入，所以后端直接返回 400 |
| `library` | **目前没有任何代码产生它**，预留给正式物料库的导入器 | 由上游系统决定，可能只有一个外链 | 归上游系统管，本服务返回 400 |

界面上只分两栏：**原料库**（`builtin` + `library`）和**我上传的**（`upload`）。
分栏逻辑集中在 `frontend/src/lib/assets.ts` 的 `filterAssets` / `bucketOf` / `canDelete`，
正式物料库接进来时前端这一侧不需要改——`library` 已经算在「原料库」那一栏里。

## 2. 为什么 `edit_spec` 不用动

贴纸图层存的是 `asset_id`，不是路径也不是 URL：

```jsonc
{ "id": "l_1", "type": "sticker", "asset_id": "a_s1t2u3", "anchor": "top-left", ... }
```

这层间接已经是正确的接缝。素材换成从哪儿来、文件放在哪儿、URL 长什么样，`edit_spec` 一个字都不用改，
因此 **`spec_version` 保持 1，历史 spec 继续可用，批量套用 / 回传 JSON 都不受影响**。

这也意味着迁移的代价集中在「`asset_id` → 实际字节」这一次解析上，而不是散落在整个产品里。

## 3. 迁移时要改的三处

### 3.1 worker 侧的素材解析 —— `backend/app/services/render.py` 的 `collect_assets()`

现在是纯本地：`storage.asset_path(asset.id, asset.ext)` 拼出磁盘路径，Pillow 读尺寸。

迁移后要变成「本地文件 **或** 下载缓存」：`source != "library"` 走原路径；`library` 先看
`DATA_DIR/assets/cache/{asset_id}.{ext}` 是否命中，没有就从上游下载再落盘。
**ffmpeg 只能读本地文件，外链素材必须先落盘**，这一步绕不过去。

失败处理沿用现有约定：解析不到就跳过该图层并写进 `RenderPlan.warnings`，任务仍是 `done` 带警告，不整体失败。

### 3.2 返回给前端的 URL —— `backend/app/serializers.py` 的 `asset_out()`

现在恒等于 `storage.media_url(storage.asset_path(...))`，即站内 `/media/assets/...`。

迁移后 `library` 素材直接返回上游的 `https://` 绝对地址。契约 §0 已经为这一条开了口子
（「`*_url` 都以 `/media/` 开头」的唯一例外），前端把 `url` 当不透明字符串用，不需要改。

**注意**：`ACCESS_CODE` 访问码网关只拦 `/api` 与 `/media`，外链素材不经过它。
如果上游物料库要求鉴权，就不能把地址直接发给浏览器，得改成由本服务代理（多一个 `/media/library/{id}` 路由），
这会让 3.1 的缓存变成必选项。

### 3.3 新增一个只读导入器

把物料库的条目登记成 `source = "library"` 的 Asset。可以是定时同步，也可以是一个
`POST /api/assets/import` 之类的内部路由。要点：

- `POST /api/assets` **保持只产出 `source = "upload"`**，不要让它兼职导入；
- `DELETE /api/assets/{id}` 已经拒绝非 `upload` 的素材，不用改。

### 3.4 届时要加的字段（现在不加）

| 字段 | 用途 |
|---|---|
| `Asset.external_id` | 物料库里的条目 id，用来做幂等同步和「这张图在正式库里是哪条」的回溯 |
| `Asset.remote_url` | 上游地址；`asset_out()` 的 `url` 由它产出 |

**现在不加是刻意的**：`backend/app/db.py` 的 `init_db()` 只做 `Base.metadata.create_all`，仓库里没有迁移框架，
给已经跑起来的库加列需要手写一条 `ALTER TABLE`。原型阶段这两个字段没有任何读写方，先把设计写在这里，
真正接入时连同导入器一起加，一次迁移解决。

## 4. 不打算做的事

- **不引入 provider / 存储抽象层。** `asset_id` 这层间接已经够用，再加一层抽象只会让迁移时要改的地方从三处变成四处。
- **不在 `edit_spec` 里存素材 URL 或来源。** spec 是要被批量套用、跨视频复制、回传给上游的，塞进易变的东西只会制造迁移债。

## 5. 上传限制（原型阶段）

| 项 | 值 | 在哪 |
|---|---|---|
| 贴纸格式 | png / webp / gif，mp4 / mov / webm | `backend/app/routers/assets.py` `STICKER_EXTS` |
| 字体格式 | ttf / otf / woff2 | 同上 `FONT_EXTS` |
| 单文件上限 | 图片贴纸 10 MiB、视频贴纸（mp4 / mov / webm）1 GiB、字体 20 MiB；视频贴纸不限时长 | 同上 `MAX_BYTES` / `MAX_VIDEO_STICKER_BYTES`；前端 `frontend/src/lib/assets.ts` `UPLOAD_LIMITS` 先挡一次 |
| 动态 gif / webp | 与视频文件一样走视频贴纸（异步预处理），但大小仍按图片的 10 MiB | 同上 `create_assets` |
| 贴纸音轨 | 预处理记 `has_audio`；图层 `mix_audio = true` 时合成进成片，默认不合成 | 契约 §2、`filtergraph.py` |
| 音频素材 | `type = audio`：mp3 / wav / m4a，单个 50 MiB；上传后异步 `ffprobe` 时长，没有派生文件；在剪辑步骤加为 BGM / 口播（`edit_spec.audio.tracks`） | 同上 `AUDIO_EXTS`；契约 §1 / §2 |
| 请求体上限 | 主域名 2 GiB，但 **Cloudflare 免费版在 100 MB 处先拦下（413）**；上传子域名 1100 MiB | `deploy/nginx/hitgo.conf` |

**大文件为什么走上传子域名**：`hitgo.mrlgs.net` 走 Cloudflare 代理，免费版单个请求超过 100 MB 会被
Cloudflare 直接回 413，请求根本到不了源站（浏览器里表现为「网络错误」，HIG-6）。配置了 `UPLOAD_BASE_URL`
后，前端先在主域名 `POST /api/assets/upload-ticket` 拿一张 10 分钟的 ticket，再把文件直接传到不经
Cloudflare 的上传子域名。访问码 Cookie 是 host-only 的，而且它的值就是访问码，所以不扩到 `.mrlgs.net`，
改用 ticket。部署步骤见 `docs/DEPLOY.md`。
