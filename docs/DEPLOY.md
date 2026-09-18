# HitGO 部署说明

## 1. 本地开发

后端（需要本机安装 `ffmpeg` / `ffprobe` 才能真正预处理与渲染；API 本身不依赖它们）：

```bash
cd backend
uv sync                              # 安装依赖（含 dev）
cp ../.env.example ../.env           # 可选；本地也可直接用环境变量
export DATA_DIR=$PWD/../data ENV=dev REDIS_URL=redis://localhost:6379/0
uv run uvicorn app.main:app --reload --port 8000
# 另开一个终端跑 worker（需要本机 Redis：brew install redis && brew services start redis）
uv run celery -A app.worker worker --loglevel=info --concurrency=1
```

前端：`cd frontend && npm install && npm run dev`（Vite 监听 5173，`/api` 与 `/media` 代理到 `http://localhost:8000`）。
`ENV=dev` 时后端允许 `http://localhost:5173` 跨域并携带 Cookie；生产环境前后端同源，不开 CORS。

测试：`cd backend && uv run pytest`（不需要 ffmpeg；需要二进制的集成用例会自动跳过）。

## 2. 单机 Ubuntu 部署（docker compose）

前提：Ubuntu 22.04+，已安装 Docker Engine 与 compose 插件，nginx 已在跑（复用 missiongo 的部署方式）。

```bash
sudo mkdir -p /srv/hitgo && cd /srv/hitgo
git clone <repo> .                   # 或 rsync 代码
cp .env.example .env
$EDITOR .env                          # 至少设置 ACCESS_CODE 与 PUBLIC_BASE_URL=https://hitgo.mrlgs.net
mkdir -p data
docker compose build
docker compose up -d
docker compose ps                     # api 应为 healthy
curl -s http://127.0.0.1:8790/api/health
```

- 镜像多阶段构建：`node:22-alpine` 构建 `frontend/dist` → `python:3.12-slim` + apt `ffmpeg` + `uv`，API 与 worker 共用同一镜像。
- `separator` 服务用另一个镜像 `Dockerfile.separator`（同一份后端代码 + `uv sync --extra separate`：CPU 版 torch、Demucs，
  构建时预取 htdemucs 权重约 80 MB），只消费 Celery 的 `separate` 队列，`mem_limit: 5g`。首次构建要从 PyPI / PyTorch 源
  下载约 300 MB 的 wheel，镜像约 2.5 GB；`htdemucs_ft` 权重（4 × 80 MB）在第一次用高质量模式时下载，存在容器层里，
  重建镜像后要重新下。没起这个服务时分离任务一直停在 queued，其余功能不受影响。
- 界面上 HitGO 旁的版本号是构建期写死的最近 git tag（如 `v0.8.0`）：取值顺序 `HITGO_VERSION` 环境变量 → `frontend/.hitgo-version` → `git describe --tags --abbrev=0`，都没有显示 `dev`。镜像里没有 `.git`，`scripts/deploy.sh` 会在服务器构建前写入 `frontend/.hitgo-version`；手动 `git clone` 部署时在构建前自己写一份。在 `make release` 打 tag 之前部署，显示的是上一个 tag。
- `api` 只监听 `127.0.0.1:8790`，由 nginx 反代；`redis` 不对外暴露端口。
- 所有数据（SQLite、源片、成片）都在 `./data`，备份/迁移只需拷贝这个目录。
- 更新：`git pull && docker compose build && docker compose up -d`。
- 日志：`docker compose logs -f api worker separator`。
- 渲染并发：`.env` 里的 `WORKER_CONCURRENCY`（默认 1，每路 ffmpeg 会吃满若干核，按机器调）。

## 3. nginx server block（模板）

放到 `/etc/nginx/sites-available/hitgo.conf` 并软链到 `sites-enabled`，与本机已有的 `missiongo.conf` 保持同一套模式：**只允许 Cloudflare 回源 IP**、复用同一份证书路径。下面是模板，`include`/证书路径按 missiongo.conf 实际值替换。

```nginx
# /etc/nginx/sites-available/hitgo.conf
server {
    listen 80;
    server_name hitgo.mrlgs.net;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name hitgo.mrlgs.net;

    # 与 missiongo.conf 相同的证书（Cloudflare Origin Cert 或 Let's Encrypt）
    ssl_certificate     /etc/ssl/mrlgs/fullchain.pem;      # ← 按 missiongo.conf 实际路径
    ssl_certificate_key /etc/ssl/mrlgs/privkey.pem;        # ← 按 missiongo.conf 实际路径
    ssl_protocols TLSv1.2 TLSv1.3;

    # 只放行 Cloudflare 回源网段（与 missiongo.conf 共用同一份 include）
    include /etc/nginx/snippets/cloudflare-allow.conf;     # allow <cf ranges>; deny all;
    real_ip_header CF-Connecting-IP;

    # 大文件上传：源片可能上百 MB，成片下载走 /media
    client_max_body_size 2g;
    proxy_request_buffering off;       # 边收边转发，不在 nginx 落盘
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # 成片 / 代理视频支持 Range 拖动，直接透传即可
    location /media/ {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Range $http_range;
        proxy_buffering off;
    }

    access_log /var/log/nginx/hitgo.access.log;
    error_log  /var/log/nginx/hitgo.error.log;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/hitgo.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Cloudflare 侧：为 `hitgo.mrlgs.net` 添加代理（橙云）A 记录指向该主机；SSL 模式与 missiongo 一致（Full (strict)）。
Cloudflare 免费版单次上传上限 100 MB（超过直接回 413，到不了源站）。**素材库的贴纸上传和批次源片上传**
通过上传子域名绕开，见下一节；未配置上传子域名时仍走主域名，单个请求要压在 100 MB 内。

## 3.1 上传子域名（大文件贴纸和批次源片，HIG-6 / HIG-69）

`deploy/nginx/hitgo.conf` 里的第二个 server 块。只代理 `POST /api/assets` 和 `POST /api/batches/{id}/videos`，其余 404。前端先在主域名取
对应路径的 ticket（`POST /api/assets/upload-ticket` 或 `POST /api/batches/{id}/upload-ticket`），再把文件直接传过来（契约 §3）。上线步骤：

1. Cloudflare：加 `hitgo-upload` 的 A 记录指向源站，**DNS only（灰云）**。二级名 `hitgo-upload.mrlgs.net`
   而不是 `upload.hitgo.mrlgs.net`，以后换 `*.mrlgs.net` 通配证书也能覆盖。
2. 证书：共用的 `/etc/hermes-edge/tls` 只覆盖 `mrlgs.net`，要单独签。80 端口被 derper 占着，沿用
   现有 mrlgs.net 续期的 standalone 做法：
   ```bash
   sudo certbot certonly --standalone -d hitgo-upload.mrlgs.net \
     --pre-hook "systemctl stop derper.service" \
     --post-hook "systemctl start derper.service" \
     --deploy-hook "systemctl reload nginx"
   ```
3. nginx：`sudo cp deploy/nginx/hitgo.conf /etc/nginx/conf.d/hitgo.conf && sudo nginx -t && sudo systemctl reload nginx`。
4. 服务器 `.env` 加 `UPLOAD_BASE_URL=https://hitgo-upload.mrlgs.net`，重建容器（`make deploy`）。
5. 验证：浏览器在素材库上传一个 >100 MB 的 mp4，并新建批次上传或向已有批次追加一个 >100 MB 的 mp4；开发者工具里两个上传请求都应发往 `hitgo-upload.mrlgs.net`，且视频最终进入批次。失败时记录页面显示的 `UPLOAD_...` 错误码与请求状态。
   不配 `UPLOAD_BASE_URL` 时一切照旧（同源上传，100 MB 以内可用）。

批次上传失败时，页面还会显示诊断编号。用该编号在 API 容器日志中查找 `upload_client_failure`、`upload_request_received`、`upload_request_finished`。只有客户端失败记录、没有收到上传请求的记录，提示大文件请求未到达应用（再查 CDN / nginx）；收到了请求但没有成功状态，再按日志中的状态码和耗时查应用或连接。完全断网时客户端诊断上报也可能无法送达。日志只含诊断编号、批次 ID、文件数量/总字节数、错误码、状态和耗时，不记录文件名、Cookie 或票据。

注意：灰云会暴露源站 IP（这台机器的 IP 已经出现在 `47.239.30.253.sslip.io` 证书里，没有新增暴露面），
上传子域名也不在 Cloudflare 的回源白名单保护下，所以 nginx 只放行这一个接口，接口本身需要 ticket。

## 4. 环境变量一览

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `/data` | 数据根目录（compose 挂载 `./data`） |
| `DATABASE_URL` | `sqlite:///{DATA_DIR}/hitgo.db` | 可换 PostgreSQL（`postgresql+psycopg://…`，需自行加驱动依赖） |
| `REDIS_URL` | `redis://localhost:6379/0` | Celery broker/backend；compose 内固定为 `redis://redis:6379/0` |
| `ACCESS_CODE` | 空 | 非空则 `/api`、`/media` 需 Cookie `hitgo_access` |
| `PUBLIC_BASE_URL` | `http://localhost:8000` | 回传 JSON 里成片的绝对地址前缀 |
| `UPLOAD_BASE_URL` | 空 | 上传子域名（如 `https://hitgo-upload.mrlgs.net`），非空时素材库与批次视频上传直传过去并对 `PUBLIC_BASE_URL` 开 CORS，见 3.1 |
| `WORKER_CONCURRENCY` | `1` | worker 并行渲染数 |
| `SEPARATE_THREADS` | `4` | separator 里 torch 的线程数（4 核机器上 4；和渲染并行时可减到 2） |
| `SEPARATE_MAX_SECONDS` | `600` | 分离接受的最长源音轨（秒），更长直接 failed |
| `DASHSCOPE_API_KEY` | 空 | 阿里云百炼 key，改语言（听写 / 翻译 / 配音）用；空则 `GET /api/localize/options` 返回 `enabled=false`，前端禁用模块 |
| `LOCALIZE_PROVIDER` | `dashscope` | `dashscope` \| `fake`（假听写 / 假翻译 / 静音配音，只用于测试和演示） |
| `LOCALIZE_ASR_MODEL` / `LOCALIZE_MT_MODEL` / `LOCALIZE_TTS_MODEL` | `paraformer-realtime-v2` / `qwen-mt-plus` / `cosyvoice-v3-flash` | 百炼模型；换 TTS 模型必须同时换音色（`_v3` 音色只配 v3 系列） |
| `LOCALIZE_MAX_SECONDS` | `600` | 改语言接受的最长源视频（秒） |
| `LOCALIZE_MAX_TEMPO` | `1.3` | 译文配音塞不进原句时段时最多加速几倍；仍超出时写进版本 `warnings` |
| `LOCALIZE_TIMEOUT_SECONDS` | `900` | 一次改语言任务的软超时（秒）；超时后进行中的版本记 failed |
| `LOCALIZE_VOICES` | 空 | `lang=voice[@model]`，如 `ko=loongjihun_v3,ar=loongmary@qwen-audio-3.0-tts-flash`：按语言覆盖默认音色或给还没有默认音色的语言加一个（该语言随即出现在目标语言列表）；`@model` 缺省为 `LOCALIZE_TTS_MODEL` |
| `MINIMAX_TTS_MODEL` | 空 | 百炼托管的 MiniMax 语音模型（HIG-59），第二家系统音色来源，仍用 `DASHSCOPE_API_KEY`。**缺省留空 = 不启用**；开启前必须先在百炼控制台开通 MiniMax 语音模型（只有华北2（北京）提供），没开通时百炼回 400 `The product is not activated`，而后端无法预先判断，界面上会出现音色但每次合成都 502。建议值 `MiniMax/speech-2.8-hd`；也可 `speech-2.8-turbo` / `speech-02-hd` / `speech-02-turbo`（turbo 2 元/万字符、hd 3.5 元/万字符，cosyvoice 约 0.8–1 元）。留空则泰 / 越 / 阿 不出现在目标语言列表。**该模型限 20 RPM**，worker 每进程已强制 3.1 秒间隔自我节流，`WORKER_CONCURRENCY` 调大或多语言并行配音时建议在百炼控制台申请提高 RPM 配额 |
| `ENV` | `prod` | `dev` 开启 Vite 跨域 |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | 二进制路径 |

## 实际部署记录（mrlgs.net，2026-09-14）

- 代码目录 `/srv/hitgo/app`（rsync 自本机 `~/Projects/HitGO`，排除 `.git node_modules dist .venv /data .env`；注意 `/data` 要写成锚定形式，否则会把 `backend/app/data/` 也排除掉），数据目录 `/srv/hitgo/data`（`app/data` 是指向它的符号链接，目录权限 777 供容器内 `hitgo` 用户写入）。
- `.env` 由手工写入：`ACCESS_CODE`、`PUBLIC_BASE_URL=https://hitgo.mrlgs.net`、`WORKER_CONCURRENCY=1`、`ENV=prod`。
- Docker 需要 `sudo`（部署用户不在 docker 组）：`cd /srv/hitgo/app && sudo docker compose build && sudo docker compose up -d`。
- nginx：`deploy/nginx/hitgo.conf` → `/etc/nginx/conf.d/hitgo.conf`，`sudo nginx -t && sudo systemctl reload nginx`。DNS 为 Cloudflare 代理记录（橙色云）。
- 演示素材：`scripts/make_demo_media.sh /srv/hitgo/demo` 生成占位视频与贴纸；`scripts/seed_demo.sh http://127.0.0.1:8790 <code> /srv/hitgo/demo` 建演示批次；`scripts/smoke_render.py` 走一遍剪辑 + 贴纸 + 双变体渲染。
- 更新流程：本机改代码 → rsync → `sudo docker compose build && sudo docker compose up -d`（约 1–2 分钟，镜像层有缓存）。

## 百炼（改语言）接入自检

拿到 API-KEY 后先在本机跑一遍，不用部署：

```bash
cd backend && DASHSCOPE_API_KEY=sk-xxx uv run python ../scripts/check_dashscope.py --target ko
```

脚本按 TTS → ASR → 翻译 → 目标语言 TTS 走一圈，逐步打印耗时与百炼返回的原因（key 无效、模型未开通、余额不足会直接看到）。
三步都通再把 key 写进服务器 `.env` 的 `DASHSCOPE_API_KEY`，`docker compose up -d` 重启 api / worker 即可。worker 需要能出网访问
`dashscope.aliyuncs.com:443`（ASR / TTS 走 WebSocket）。
