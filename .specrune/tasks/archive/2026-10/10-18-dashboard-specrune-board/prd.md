# PRD — Dashboard 集成 SpecRune 工作流看板

## Goal & value

在 clawd-on-desk 现有 Dashboard（Trellis 面板/视图）的基础上，让它识别出
`.specrune/` 根目录并展示其工作流任务与工件报告（prd / design / implement /
research / 归档 / spec 树）。用户无需打开终端即可在熟悉的看板里总览 SpecRune
项目的任务全景。本仓库自身已完成 .trellis → .specrune 迁移，是直接受益者。

## Key decisions

- **D1 (用户已确认)**: v1 为纯只读 — 不写 `.specrune/` 任何字节、不调用有副作用
  的 specrune 命令。
- **D2 (用户澄清 2026-10-18)**: 不新造并行看板，而是在现有 Dashboard/Trellis 面板
  的基础上，让它识别出 `.specrune/` 根目录并展示其工作流任务与工件报告。
- **D3 (用户已确认)**: 同一视图混排 — 复用现有 Trellis 视图/详情/归档/spec 树渲染，
  任务卡以来源徽标区分 `.trellis` / `.specrune`。
- **D4 (技术决策，证据支持)**: 数据源为直接只读文件解析（镜像 trellis-activity
  的做法），不 shell out 到 specrune CLI — 零外部依赖、与现有信任模型一致。

## Confirmed facts

### clawd-on-desk 侧（research/clawd-dashboard-trellis-architecture.md）

- 链路：`src/trellis-activity.js`（唯一只读读取层）→ `src/session-ipc.js`
  `dashboard:trellis-*` 处理器（:187-360，可信帧 + 精确键校验）→
  `src/preload-dashboard.js`（:87-97）→ `src/dashboard-renderer.js` +
  `src/dashboard-trellis-panel.js`（纯聚合 UMD）。
- 嵌入面板的数据来自 per-session 绑定（snapshot `entry.trellis`），由
  `.trellis/.runtime/sessions` 指针文件驱动 → SpecRune 任务要在面板出现，会话
  指针识别（`.specrune/.runtime/sessions`）是必需项而非可选项。
- 根发现：`createTrellisActivity` 轮询 live session cwd（main.js:2529-2554）→
  `~/.clawd/trellis-roots.json`（src/trellis-roots.js，MAX 64）+ 目录选择器手动添加。
- i18n 单文件 7 语言（src/i18n.js）；样式内联 dashboard.html；测试模式：
  test/dashboard-trellis-panel.test.js（fake DOM）与 test/trellis-activity.test.js
  （注入 fake fs）。注意旧测试里有已失效的死导入，镜像测试须对照真实导出。

### SpecRune 侧（research/specrune-data-model.md）

- `.specrune/` 与 `.trellis/` 几乎同构：`tasks/<MM-DD-slug>/{task.json, prd.md,
  design.md, implement.md, implement.jsonl, check.jsonl, research/}`、
  `tasks/archive/<YYYY-MM>/`、`.runtime/sessions/<platform>_<id>.json`
  （current_task 指针）、`spec/<package>/*.md`、`sessions/*.md`。
- task.json 权威 schema：.specrune/spec/backend/disk-format.md:171-228。status
  白名单 planning/in_progress/completed/canceled；读时须容忍遗留 `done`、
  未知键与自定义状态。
- 阶段由 status 推导；hasPrd/hasDesign/hasImpl 与 implement.md 复选框提供
  细粒度进度。
- 仓库内先例：.agents/skills/specrune-board/assets/specrune-board.html（只读
  单文件看板）。

## Requirements

1. **读取层**：现有 trellis 读取层识别 `.specrune` 根（与 `.trellis` 并列），
   解析 task.json / 工件文档 / 归档 / spec 树 / 会话指针，返回与现有数据形状
   同构的结果（含来源标记 `workflow: "specrune"`）。
2. **status → phase 映射**：planning→plan、in_progress→execute、completed 与
   遗留 done→finish（非归档的终态）、canceled 及未知状态→null（不渲染，同
   SpecRune IsUnboundStatus 语义）；未知自定义状态不报错。
   implement.md 复选框进度沿用现有 progress 通道。
3. **根发现**：live session cwd 下发现 `.specrune` 自动注册 + 手动添加；持久化
   与 `.trellis` 根共存（复用/一般化现有 roots store，见 design.md）。
4. **会话绑定**：识别 `.specrune/.runtime/sessions` 指针，使现有 session→task
   绑定、嵌入面板与 HUD 提示对 SpecRune 会话生效。
5. **展示**：现有视图混排 SpecRune 任务；任务卡带 SpecRune 来源徽标；详情/
   文档/spec 树/归档视图复用现有渲染（markdown 复用 trellis-doc-renderer）。
6. **i18n**：7 语言新增 `dashboardSpecrune*` 与必要 phase/徽标键。
7. **测试**：镜像 trellis 测试模式（fake DOM 面板测试 + 注入 fs 的读取层测试）。

## Acceptance criteria

- [ ] 在含 `.specrune/` 的项目里启动 agent 会话后，Dashboard Trellis 视图能在
      无手动配置的情况下列出该项目 SpecRune 任务（自动根发现 + 会话指针绑定）。
- [ ] 任务卡显示标题、状态徽标（映射后 phase 分组）、进度（implement.md 复选框）、
      SpecRune 来源徽标；`.trellis` 任务展示不受任何影响（回归）。
- [ ] 点击任务可查看详情与 prd/design/implement 等 markdown 工件（渲染正常、
      超长截断行为与现有一致）。
- [ ] 归档任务出现在归档列表（按月分组）；spec 树可浏览 `.specrune/spec/`。
- [ ] task.json 含未知键/未知状态、目录缺文件、task.json 损坏时均不崩溃：
      任务降级展示或跳过，其余任务正常。
- [ ] 手动"添加根"可选择 `.specrune` 所在项目并生效；移除生效；重启后保留。
- [ ] `npm test` 全绿，新增镜像测试覆盖上述行为；7 语言键齐全
      （缺键回退英文不出现）。
- [ ] 全程零写入 `.specrune/`（只 readFile/stat/readdir）。

## Coverage taxonomy

1. Goal & scope — covered（D1-D3）。
2. Domain & data — covered（research 两份：task.json schema、目录布局、指针格式）。
3. Interaction & states — covered（复用现有视图交互；加载/错误/空态沿用现有面板
   语义）。
4. Non-functional quality — covered（只读、轮询节奏沿用 5s/15s、列表上限沿用
   ACTIVE_LIST_MAX 等）。
5. Integration & dependencies — covered（D4 直读文件，零 CLI 依赖；兼容遗留
   `done` 状态）。
6. Edge cases & failure handling — covered（验收标准第 5 条：未知键/状态、缺文件、
   损坏 JSON 容忍）。
7. Constraints & trade-offs — covered（D1-D4；混排 vs 独立标签的取舍已决）。
8. Completion signals — covered（验收标准）。

## Implicit requirements sweep

- 崩溃不丢数据 — not-applying：纯只读查看器，不产生需持久化的用户数据
  （roots store 沿用现有原子写机制）。
- 敏感/个人数据 — applied：`.specrune/` 可能含笔记与会话记录，仅本机 Dashboard
  展示，不外发；与 `.trellis` 同等对待。
- 权限 — applied：只读 fs 访问；手动加根走系统目录选择器（main 侧），渲染进程
  无法传任意路径（沿用可信帧 + 精确键校验）。
- 审计 — not-applying：只读查看器不产生变更。
- 失败时用户所见 — applied：根不可读/任务损坏时降级展示并保留其余内容（验收 5）。
- 依赖现有行为方/兼容 — applied：`.trellis` 行为零回归（验收 2）；遗留 `done`
  状态读兼容。
- 无障碍/本地化 — applied：新增 7 语言键；aria/键盘导航沿用现有视图实现。

## Out of scope

- 不修改 SpecRune 工具本身。
- 任务写操作（创建 / 开始 / 归档）—— v1 明确排除（D1）。
- Settings 页的 SpecRune 安装/升级向导（Trellis 有，SpecRune 不做）。
- SpecRune 专属的 spec 契约图（req anchor 引用图，specrune-board skill 有）
  —— 可作后续任务。

## Open questions

（无阻塞项）
