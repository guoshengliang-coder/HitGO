# HitGO

面向信息流投放素材的轻量视频后期工作台：承接 AI 素材系统产出的视频，在浏览器里完成剪废片、换 BGM / 口播（含 AI 人声 / 伴奏分离）、加贴纸文字、改尺寸、批量套用，渲染后回传入库。

- 需求与方案：`docs/` · 前后端契约：`docs/CONTRACT.md` · 部署：`docs/DEPLOY.md`
- 后端：`backend/`（FastAPI + Celery + FFmpeg，`uv run pytest`）
- 前端：`frontend/`（Vite + React + Konva，`npm test`）
- 改语言（听写 → 翻译 → 生成口播，两步分开点，口播生成完可自动套用（HIG-56），`docs/CONTRACT.md` §6）走阿里云百炼（CosyVoice + Qwen3-TTS，目标语言含中英日韩粤印尼西葡法德意俄；音色按性别分组、可试听，中文约 30 个，HIG-42）：`.env` 里配 `DASHSCOPE_API_KEY`，任务跑在普通 worker 上；没配 key 时模块禁用。
- 视频拼接（HIG-39）：打开批次中的已有视频，在「剪辑 → 视频片段」从本批次选择或直接上传源视频，并在播放头插入；片段可裁剪、拆分、复制、删除、排序和设置淡化 / 滑动 / 擦除转场。原有字幕、贴纸和音轨继续位于整条成片时间轴，导出为一条视频。
- 大字报（HIG-50）：一条文案配多个背景各出一条滚动文字视频。素材来源可以是上传的视频 / 图片或空白（`kind: video | image | blank`），成片时长跟文案走（`trim.duration`），文字在安全区框内滚动（`layers[].scroll`），朗读与重点词自动高亮同样走百炼（`POST /api/tts`、`POST /api/highlight`，`HIGHLIGHT_MODEL` 默认 `qwen-plus`）。文案粘贴时可按标点自动分行（行尾标点保留 / 去逗号类 / 全去，本机偏好）；面板里的「背景」分组一次勾选或上传多个背景，应用后当前这条和所选背景一起导出（HIG-55）。
- 单机部署：`docker compose up -d`（见 `.env.example`）。`separator` 服务是带 torch + Demucs 的独立镜像（`Dockerfile.separator`），只跑人声 / 伴奏分离；不起它也能用，分离任务会一直排队。

当前为原型阶段，上游接口以本地上传与本地素材库模拟。
