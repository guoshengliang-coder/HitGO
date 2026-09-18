# HitGO 集成与发布流程

适用于多人、多 agent 并行开发。原则：**任务隔离、契约先行、main 永远可部署、发布只从 main 出**。

## 1. 任务拆分与分支

| 规则 | 说明 |
|---|---|
| 一任务一分支 | `feat/<task>`、`fix/<task>`、`chore/<task>`，任务名用短横线英文，如 `feat/layer-animations` |
| 一 agent 一 worktree | `git worktree add ../HitGO-<task> -b feat/<task> main`，agent 之间不共享工作副本 |
| 任务范围写进 PR | 开工前在 PR（draft）里列出计划触碰的目录/文件，方便并行任务提前发现冲突 |
| 共享文件 | `frontend/src/store/editor.ts`、`frontend/src/pages/EditorPage.tsx`、`backend/app/schemas.py`、`docs/CONTRACT.md` 是高冲突文件；改这些的任务尽量串行，或先合并一个基础 PR 再各自 rebase |
| 分支寿命 | 尽量 ≤ 3 天；长任务拆成多个 PR 逐步合并，用 feature flag 或"预留字段"保证每一步 main 可用 |
| 合并后清理 | 远程分支由 GitHub 自动删除；本地执行 `make task-done b=feat/<task>` 删除 worktree 和本地分支（脚本会先确认 PR 已合并） |

## 2. 契约变更流程

1. 先改 `docs/CONTRACT.md`（字段、语义、默认值），在 PR 里标注 `contract` 标签。
2. 新字段必须可选、带默认；旧客户端发来的 spec 仍能通过校验；`spec_version` 保持 1，除非做了不兼容变更（届时同时写迁移）。
3. 前后端在同一个 PR 里落地，或后端先合并（兼容），前端后合并；反过来不行。
4. `mocks/index.ts` 同步实现新路由，保证 `npm run dev:mock` 可用。

## 3. 提交与 PR

- 提交前 `make test`；提交信息首行 ≤ 72 字符。
- PR 用模板：改了什么 / 为什么 / 如何验证 / 契约变更 / 手测清单 / 风险。
- CI（`.github/workflows/ci.yml`）在每个 PR 上跑：后端 pytest、前端 typecheck + vitest + build、Docker 镜像构建。全绿才可合并。
- 合并方式：**Squash merge**，保持 main 一条直线；合并前 rebase 到最新 main 解决冲突（不要用 merge commit 回灌 main）。
- 评审：至少一个人看过（agent 提交的 PR 由人合并；人提交的 PR 可让 agent 先跑 `/code-review`）。

## 4. main 的约束

- 分支保护：禁止直接 push、要求 PR、要求 CI 状态检查通过、要求分支为最新。
- main 上的每个提交都应能 `make deploy` 成功——这是"随时可发布"的保证。
- 出现 main 红灯，优先级最高：立刻修或 revert，不在红灯上叠加新 PR。

## 5. 发布

```
main 绿 → make release v=0.x.y → 推 tag → deploy.yml 构建镜像 → rsync 到服务器 → docker compose up → smoke_render.py
```

- 版本号语义：`0.x` 原型阶段，`x` 每次功能批次 +1，`y` 修复 +1。
- `deploy.yml` 支持两种触发：推 `v*` tag（正式发布）和手动 `workflow_dispatch`（临时部署某个分支到原型环境做演示）。
- 部署失败自动停在 smoke 阶段，不会回滚（原型阶段），手动 `git checkout <上一个 tag> && make deploy` 即可回退。
- 发布后在 GitHub Release 里贴上变更摘要（可由 tag 之间的提交信息生成）。

## 6. 热修复

`fix/<issue>` 从 main 拉分支 → PR → squash 合并 → `make release v=0.x.(y+1)`。不从 tag 拉分支（原型阶段不维护多版本线）。

## 7. 多 agent 并行的实操建议

- **先分配边界再开工**：一个 agent 负责后端 + 契约，一个负责前端；或按功能垂直切分但明确谁改共享文件。
- **基础设施先合并**：涉及公共基建（快捷键注册表、store 新字段、新的 API client 方法）的部分先做成一个小 PR 合掉，其他 agent 基于它开分支。
- **并行 PR 互相 rebase**：第一个合并后，其余分支 `git rebase main`，重新跑 `make test` 再更新 PR。
- **每个 agent 汇报时附 `git diff --stat`**，人只看范围是否越界与验证结果。
- **agent 不做的事**：不直接推 main、不打 tag、不改分支保护、不部署（除非任务明确要求并给了权限）。

## 8. 迁移到公司 GitLab 时

- `git remote set-url origin <gitlab>` 推送全部历史。
- `ci.yml` / `deploy.yml` 改写为 `.gitlab-ci.yml`（阶段一一对应：test → build → deploy），部署目标和 secrets 换成公司环境。
- 分支保护规则在 GitLab 的 Protected branches 里重设。

## 9. 界面用词表

同一概念只用一个词，写文案、命名 props、写测试描述时都照这个来（来源：docs/DESIGN.md §8.2）。

| 用 | 不用 | 说明 |
|---|---|---|
| 勾选 | 选中、已选中 | 左栏勾选框勾上的视频，是批量操作的目标 |
| 选中 | 选择、激活 | 画布 / 图层列表 / 时间线上当前操作的对象 |
| 当前 | 正在编辑 | 左栏正在编辑的那条视频 |
| 删除区间 | 剪掉、已删除区间、删区间 | 剪辑模块里从成片中去掉的时间段 |
| 导出 | 成片画面、出片 | 生成成片的动作；「成片画面」只指画幅 / 填充设置那一组 |
| 图层 | 层 | 文字、贴纸、遮盖统称 |
| 叠加素材 | 视频贴纸、画中画 | 叠在画面上的视频素材（契约里仍是 `sticker` 图层，`Asset.kind = "video"`）；静态图仍叫贴纸 |
| 入点 / 出点 | 起止时间、裁剪点 | 素材内用到的那一段（`source_in` / `source_out`）；时间轴上的显示时段仍叫时段 |
| 音轨 | 轨道、音频层 | 音频模块里的每一条 |
| 移除 | 删除 | 从批次里去掉一条视频（源文件是否删除另说） |
| 重置 | 恢复默认、清除 | 把一组属性恢复到默认值 |
| 套用 | 应用 | 把样式预设 / 语言版本作用到当前图层或视频 |
| 应用到 | 套用到、同步到 | 批量把当前配置作用到勾选的视频 |
