# HitGO

面向信息流投放素材的轻量视频后期工作台：承接 AI 素材系统产出的视频，在浏览器里完成剪废片、换 BGM / 口播、加贴纸文字、改尺寸、批量套用，渲染后回传入库。

- 需求与方案：`docs/` · 前后端契约：`docs/CONTRACT.md` · 部署：`docs/DEPLOY.md`
- 后端：`backend/`（FastAPI + Celery + FFmpeg，`uv run pytest`）
- 前端：`frontend/`（Vite + React + Konva，`npm test`）
- 单机部署：`docker compose up -d`（见 `.env.example`）

当前为原型阶段，上游接口以本地上传与本地素材库模拟。
