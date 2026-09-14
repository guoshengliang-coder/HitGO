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
- `api` 只监听 `127.0.0.1:8790`，由 nginx 反代；`redis` 不对外暴露端口。
- 所有数据（SQLite、源片、成片）都在 `./data`，备份/迁移只需拷贝这个目录。
- 更新：`git pull && docker compose build && docker compose up -d`。
- 日志：`docker compose logs -f api worker`。
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
Cloudflare 免费版单次上传上限 100 MB——更大的源片需关闭该域名的代理（灰云）或走企业套餐；原型阶段建议上传前先把源片压到 100 MB 内。

## 4. 环境变量一览

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `/data` | 数据根目录（compose 挂载 `./data`） |
| `DATABASE_URL` | `sqlite:///{DATA_DIR}/hitgo.db` | 可换 PostgreSQL（`postgresql+psycopg://…`，需自行加驱动依赖） |
| `REDIS_URL` | `redis://localhost:6379/0` | Celery broker/backend；compose 内固定为 `redis://redis:6379/0` |
| `ACCESS_CODE` | 空 | 非空则 `/api`、`/media` 需 Cookie `hitgo_access` |
| `PUBLIC_BASE_URL` | `http://localhost:8000` | 回传 JSON 里成片的绝对地址前缀 |
| `WORKER_CONCURRENCY` | `1` | worker 并行渲染数 |
| `ENV` | `prod` | `dev` 开启 Vite 跨域 |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | 二进制路径 |

## 实际部署记录（mrlgs.net，2026-09-14）

- 代码目录 `/srv/hitgo/app`（rsync 自本机 `~/Projects/HitGO`，排除 `.git node_modules dist .venv /data .env`；注意 `/data` 要写成锚定形式，否则会把 `backend/app/data/` 也排除掉），数据目录 `/srv/hitgo/data`（`app/data` 是指向它的符号链接，目录权限 777 供容器内 `hitgo` 用户写入）。
- `.env` 由手工写入：`ACCESS_CODE`、`PUBLIC_BASE_URL=https://hitgo.mrlgs.net`、`WORKER_CONCURRENCY=1`、`ENV=prod`。
- Docker 需要 `sudo`（部署用户不在 docker 组）：`cd /srv/hitgo/app && sudo docker compose build && sudo docker compose up -d`。
- nginx：`deploy/nginx/hitgo.conf` → `/etc/nginx/conf.d/hitgo.conf`，`sudo nginx -t && sudo systemctl reload nginx`。DNS 为 Cloudflare 代理记录（橙色云）。
- 演示素材：`scripts/make_demo_media.sh /srv/hitgo/demo` 生成占位视频与贴纸；`scripts/seed_demo.sh http://127.0.0.1:8790 <code> /srv/hitgo/demo` 建演示批次；`scripts/smoke_render.py` 走一遍剪辑 + 贴纸 + 双变体渲染。
- 更新流程：本机改代码 → rsync → `sudo docker compose build && sudo docker compose up -d`（约 1–2 分钟，镜像层有缓存）。
