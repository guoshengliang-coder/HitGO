# HitGO — 协作规则（人和 agent 都遵守）

HitGO 是面向投放素材的轻量视频后期工作台。后端 `backend/`（FastAPI + Celery + FFmpeg，uv 管理），前端 `frontend/`（Vite + React + Konva），契约 `docs/CONTRACT.md`，流程细则 `docs/WORKFLOW.md`。

## 命令

```bash
make test            # 后端 pytest + 前端 typecheck/test/build（与 CI 一致）
make test-backend    # cd backend && uv run pytest -q
make test-frontend   # cd frontend && npm run typecheck && npm test && npm run build
make deploy          # 从当前 main 部署到原型服务器（需要 SSH 权限，见 docs/DEPLOY.md）
```

本机没有 ffmpeg / Docker：涉及渲染的验证在原型服务器上跑 `scripts/smoke_render.py`。

## 分支与提交

- `main` 受保护：不能直接推送，只接受 PR，CI 必须绿。
- 一个任务一个分支：`feat/<task>`、`fix/<task>`、`chore/<task>`，多 agent 并行时每个 agent 用自己的分支 + 独立 worktree（`git worktree add ../HitGO-<task> -b feat/<task>`），不要在同一个工作副本里交错改动。
- 提交信息：一行概述（≤72 字符，中文或英文均可），空一行，正文说明"为什么"；agent 生成的提交追加 `Co-Authored-By` 行。
- PR 合并后：远程分支自动删除，本地跑 `make task-done b=<branch>` 清掉 worktree 和分支，不留僵尸分支。
- 提交前必须本地 `make test` 通过；不要提交 `data/`、`.env`、`node_modules`、`dist`、`.venv`。

## 改动边界

- **契约先行**：凡是改 API、`edit_spec`、回传 JSON，先改 `docs/CONTRACT.md`，同一个 PR 里前后端一起改；新增字段一律可选并带默认值，`spec_version` 不动。
- 后端改动必须带测试（`backend/tests/`）；前端 `lib/` 里的纯函数必须带 vitest；UI 交互在 PR 描述里写手测清单。
- 不改别人任务范围内的文件。如果必须改共享文件（`store/editor.ts`、`EditorPage.tsx`、`schemas.py`、`CONTRACT.md`），在 PR 描述里说明，并 rebase 到最新 `main` 再提交。
- 不在代码里写死服务器地址、访问码、密钥；配置走环境变量（`.env.example` 列出全部）。

## 完成定义（Definition of Done）

1. CI 绿（`make test` 等价）。
2. 契约、`README`/`docs` 与实现一致。
3. 涉及渲染链路的改动，在原型服务器跑过 `scripts/smoke_render.py`。
4. PR 描述按模板填写：改了什么、为什么、怎么验证、有没有契约变更。

## 发布

- 只从 `main` 发布：`make release v=0.x.y` 打 tag → `deploy.yml` 构建并部署到原型服务器 → 自动跑 smoke。
- agent 不主动执行部署或打 tag，除非当前任务明确要求。
- 部署到公司环境时更换 `deploy.yml` 的目标和 secrets，流程不变。
