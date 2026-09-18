# HitGO

面向信息流投放素材的轻量视频后期工作台：承接 AI 素材系统产出的视频，在浏览器里完成剪废片、换 BGM / 口播（含 AI 人声 / 伴奏分离）、加贴纸文字、改尺寸、批量套用，渲染后回传入库。

- 需求与方案：`docs/` · 前后端契约：`docs/CONTRACT.md` · 部署：`docs/DEPLOY.md`
- 后端：`backend/`（FastAPI + Celery + FFmpeg，`uv run pytest`）
- 前端：`frontend/`（Vite + React + Konva，`npm test`）
- 改语言（主操作一次勾选最多 5 种目标语言、逐种选音色并生成；听写修正和单独翻译在高级操作，口播生成完可自动套用，`docs/CONTRACT.md` §6）走阿里云百炼（CosyVoice + Qwen3-TTS + 百炼托管的 MiniMax，目标语言含中英日韩粤印尼西葡法德意俄泰越阿；音色按性别分组、可试听，中文约 30 个，HIG-42）：`.env` 里配 `DASHSCOPE_API_KEY`，任务跑在普通 worker 上；没配 key 时模块禁用。泰 / 越 / 阿只有 MiniMax 音色（HIG-59，缺省不启用：`MINIMAX_TTS_MODEL` 留空时退回到前 12 种语言，开启前要先在百炼控制台开通 MiniMax 语音模型）。
- 视频拼接（HIG-39）：剪辑模块右侧默认打开「剪辑」页，管理删除区间、成片画面和时长；「视频拼接」页集中放视频片段与封面。从本批次选择或直接上传源视频，在播放头插入，并管理来源片段与转场。切页不改变播放头、画布或底部轨道；合成后沿用单视频的 I/O、Q/W、删除区间拖拽/恢复工具，可跨来源继续剪辑。字幕、贴纸和音轨使用原有模块管理，预览与导出同步跳过删除区间。
- 大字报（HIG-50）：一条文案配多个背景各出一条滚动文字视频。素材来源可以是上传的视频 / 图片或空白（`kind: video | image | blank`），成片时长跟文案走（`trim.duration`），文字在安全区框内滚动（`layers[].scroll`），朗读与重点词自动高亮同样走百炼（`POST /api/tts`、`POST /api/highlight`，`HIGHLIGHT_MODEL` 默认 `qwen-plus`）。文案粘贴时可按标点自动分行（行尾标点保留 / 去逗号类 / 全去，本机偏好）；面板里的「背景」分组一次勾选或上传多个背景，应用后当前这条和所选背景一起导出（HIG-55）。
- 多轨道时间轴（HIG-67）：时间线常显全部轨道，按「视频 / 音频 / 图层」三组可折叠，模块只决定右栏面板；图片和视频都能直接拖进画布 / 时间线 / 贴纸面板加为叠加素材（`sticker` 图层，素材库收 mp4 / mov / webm）。叠加素材可设素材内入点 / 出点（`layers[].source_in` / `source_out`，`docs/CONTRACT.md` §2），循环的是裁出来的那一段；也可整体替换素材而保留位置、时段与属性。
- 单机部署：`docker compose up -d`（见 `.env.example`）。`separator` 服务是带 torch + Demucs 的独立镜像（`Dockerfile.separator`），只跑人声 / 伴奏分离；不起它也能用，分离任务会一直排队。

当前为原型阶段，上游接口以本地上传与本地素材库模拟。
