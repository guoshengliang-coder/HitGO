# HitGO

面向信息流投放素材的轻量视频后期工作台：承接 AI 素材系统产出的视频，在浏览器里完成剪废片、换 BGM / 口播（含 AI 人声 / 伴奏分离）、加贴纸文字、改尺寸、批量套用，渲染后回传入库。

- 需求与方案：`docs/` · 前后端契约：`docs/CONTRACT.md` · 部署：`docs/DEPLOY.md`
- 后端：`backend/`（FastAPI + Celery + FFmpeg，`uv run pytest`）
- 前端：`frontend/`（Vite + React + Konva，`npm test`）
- 改语言（听写 → 翻译 → 配音，`docs/CONTRACT.md` §6）走阿里云百炼（CosyVoice + Qwen3-TTS，目标语言含中英日韩粤印尼西葡法德意俄）：`.env` 里配 `DASHSCOPE_API_KEY`，任务跑在普通 worker 上；没配 key 时模块禁用。
- 单机部署：`docker compose up -d`（见 `.env.example`）。`separator` 服务是带 torch + Demucs 的独立镜像（`Dockerfile.separator`），只跑人声 / 伴奏分离；不起它也能用，分离任务会一直排队。

当前为原型阶段，上游接口以本地上传与本地素材库模拟。
