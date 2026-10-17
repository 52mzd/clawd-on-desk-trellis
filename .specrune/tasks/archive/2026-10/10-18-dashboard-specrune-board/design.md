# Design — Dashboard 集成 SpecRune 工作流看板

## 架构与边界

原则：**不动渲染层的数据形状，把 SpecRune 吸收进读取层**。`.specrune/` 与
`.trellis/` 同构（research/specrune-data-model.md），因此最小改动是让现有
trellis 读取栈把 `.specrune` 当作第二种可识别的工作流根，并在返回数据里加
来源标记；渲染层只在"徽标 + i18n"处感知差异。

### 分层改动

1. **根识别（src/trellis-activity.js 或抽出的共享模块）**
   - `findTrellisRoot` 的逐级向上探测扩展为同时认 `.trellis` 与 `.specrune`
     （同一目录两者并存时 `.trellis` 优先，保持现状语义；实际上迁移中的仓库
     只有一者）。
   - 根对象携带 `workflow: "trellis" | "specrune"`（由命中的目录名决定）。
   - 会话指针读取：`.trellis/.runtime/sessions` 与
     `.specrune/.runtime/sessions/<platform>_<id>.json` 同格式（current_task
     相对路径），统一解析。
2. **任务解析（readTaskInfo / readTaskDetail / readActiveList / readArchiveList）**
   - task.json 解析对两者一致；SpecRune 侧额外容忍未知键、遗留 `done` 与
     自定义状态（disk-format.md:171-228）。
   - **status → phase 映射**（SpecRune 特有；trellis 走原逻辑）：
     planning→plan、in_progress→execute、completed|done→done、canceled 及
     未知→other。progress 仍取 implement.md 复选框（readChecklist 复用）。
   - readTaskDoc / readSpecTree / readSpecDoc 以根路径为参数，天然通用；
     SpecRune 的 spec 目录为 `spec/<package>/*.md` 平铺，路径校验逻辑不变
     （segment-by-segment）。
3. **根存储（src/trellis-roots.js）**
   - 一般化：store 构造参数化（文件名可传），新建
     `~/.clawd/specrune-roots.json` 实例，MAX/picks 逻辑复用。
   - 自动注册 `autoRegisterDiscoveredRoot` 按发现的目录名分发到对应 store；
     手动添加/移除流程（main.js:2643-2731）双轨并行，UI 上"添加根"仍选项目
     目录，main 侧检测其下是 `.trellis` 还是 `.specrune`（都没有则报
     no-projects）。
4. **IPC（src/session-ipc.js / src/preload-dashboard.js）**
   - 现有 `dashboard:trellis-*` 通道复用，不改名（它们已按可信帧 + 精确键
     校验防护）；返回体新增可选字段 `workflow`，旧渲染忽略不炸。
   - roots-list / roots-add / roots-remove 返回合并视图：两个 store 的并集，
     条目带 workflow 标记。
5. **渲染（src/dashboard-renderer.js / dashboard.html / i18n.js）**
   - `dashboard-trellis-panel.js` 聚合结构不变；卡片行新增来源徽标
     （SpecRune 任务显示小徽标，trellis 任务不显示，避免视觉噪音）。
   - 详情/归档/spec 树视图零结构改动，仅文案键区分。
   - i18n：7 语言新增 `dashboardSpecruneBadge`、`dashboardSpecruneHint*` 等
     少量键；phase 文案复用现有 `sessionHudTrellisPhase*`。

## 数据流与契约

session cwd →（轮询 5s/15s）→ 根探测（.trellis | .specrune）→ 指针文件 →
task.json + 工件 stat → snapshot `entry.trellis`
（新增 `workflow: "specrune"`）→ IPC → 聚合模块 → 视图。

读取层返回形状保持现状（research/clawd-dashboard-trellis-architecture.md §4），
只增不改：`entry.trellis.workflow`、task detail 的 `task.workflow`、roots 列表
条目的 `workflow`。

## 兼容性 / 迁移

- `.trellis` 行为零变化（同目录优先级、store 文件、i18n 键均不动）。
- 无数据迁移：specrune-roots.json 首次运行时新建。
- 旧渲染进程（若有缓存的 webContents）忽略未知字段，安全。

## 回滚

改动集中在读取层 + 少量渲染，单 commit 可 revert；roots JSON 新文件残留无害。

## 备选方案

- **独立第三标签页 + 全套 specrune-* 孪生模块**：结构最清晰，但要复制
  ~5000 行渲染/IPC/测试，且用户已选混排（D3）。拒绝。
- **shell out `specrune task list --json`**：schema 由 TaskSummaryOf 保证，但引入
  PATH/版本依赖与子进程开销，且工件文档仍需直读；与"零副作用只读"信任模型
  不符。拒绝（D4）。
- **把 dashboard 指向 .agents/skills/specrune-board 的单文件 HTML**：最快，但
  是另一个入口、无会话绑定集成，不满足"在原有基础上识别"。拒绝。
- **读取层不动、在 renderer 里 sniff taskPath 是否含 .specrune**：改动更小，
  但根发现/指针解析/归档都在主进程，嗅探会造成逻辑分裂。拒绝。

## As-built deviations（2026-10-18 实现）

- **根存储不分家**：design 初稿的 `~/.clawd/specrune-roots.json` 未做——store
  的语义本就是"注册的项目根"（非 workflow 目录），trellis 与 specrune 项目根
  在存储层无法区分也无需区分；单一 `trellis-roots.json` 继续服务两者，零迁移。
- **status 映射**：canceled 未落 "other" 分组而是沿用 null 语义（不渲染）——
  SpecRune 的 IsUnboundStatus 把 canceled 视为已解绑死任务，与 trellis 面板
  null-semantics 契约一致；遗留 `done` 状态映射为 finish（≡ completed）。
- **每轮 IO 预算**：root 查找从 ≤8 stat 变为 ≤16（8 层 × 2 个 workflow 目录名），
  模块头注释与测试同步更新。
- **前缀 ↔ 根强匹配**：resolveTaskDir 要求 taskPath 前缀与解析出的根目录名一致
  （.trellis/tasks/ 的路径打不开 .specrune 树），比"任一前缀即可"更贴合
  taskPath 的 snapshot-relative 契约。
- **dsh 平台别名**："deepseek-harness" → "dsh" 以真实指针文件为证据加入
  PLATFORM_ALIASES（本仓 .specrune/.runtime/sessions/dsh_session-*.json），
  使 DSH 会话能绑定 SpecRune 任务。
- **附带修复**：listChildProjectRoots 对注入 fake fs 返回的纯字符串条目使用
  规范化后的 name join（原 entry.name 在字符串形态下为 undefined）。

## 风险

- trellis-activity.js 1640 行，扩展时回归面大 → 测试镜像 + 只增不改的原则。
- SpecRune 未来演化（disk-format 变更）→ 解析层容忍未知键/状态已是需求。
- 同目录双根（迁移中间态）→ 优先级规则固定且写进测试。
