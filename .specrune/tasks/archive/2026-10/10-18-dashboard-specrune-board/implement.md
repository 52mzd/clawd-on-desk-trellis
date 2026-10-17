# Implement — Dashboard 集成 SpecRune 工作流看板

## 有序清单

1. **读取层根识别**
   - [x] 根探测双目录（WORKFLOW_DIRS，.trellis 优先），根路径携带目录名，
         会话指针 `.specrune/.runtime/sessions` 同格式直接生效。
2. **任务解析**
   - [x] task.json 解析天然容忍未知键/状态；status→phase 映射
         （planning→plan、in_progress→execute、completed|done→finish、
         canceled/未知→null）；遗留 done 兼容（trellis-phase.derivePhase）。
   - [x] readTaskInfo/Detail/ActiveList/ArchiveList/TaskDoc/SpecTree/SpecDoc/
         NetworkOverview 对 specrune 根生效，返回体加 `workflow`
         （detail 前缀与根强匹配）。
3. **根存储与注册**
   - [x] 决策变更（见 design As-built）：单一 roots store 继续服务两种项目根，
         零迁移；autoRegister/pick 流程对 .specrune 项目自动生效（双目录探测）。
4. **IPC**
   - [x] 通道复用不改名；session-hud:open-trellis-task 前缀门接受
         .specrune/tasks/。
5. **渲染**
   - [x] 会话面板行 + split 视图行：SpecRune 来源徽标
         （.trellis-workflow-badge，明暗两套）；聚合层 workflow 透传。
   - [x] i18n.js 7 语言新增 dashboardTrellisSpecruneBadge。
6. **测试**
   - [x] test/trellis-specrune-support.test.js（13 用例：绑定、双根优先级、
         列表/详情/归档/spec 树/网络图、状态映射、渲染契约静态守卫）。
   - [x] test/trellis-phase.test.js：dsh 别名真实指针 fixture + 表大小 13。
   - [x] test/trellis-activity.test.js：深度预算 8→16 更新。

## 验证记录（2026-10-18）

- `node --test` 定向套件全绿（trellis-activity 90、trellis-phase 38、
  dashboard-trellis-panel + session-ipc + recap + roots、specrune-support 13）。
- 全量 `npm test` + stash 基线 diff：fail-now ⊂ fail-base，零新增红
  （预存红 45 → 26）。
- `node --check` 全部改动文件通过；diff 无 console.log / 无新增 innerHTML。
- 待用户真机冒烟：重启 dev 实例后打开 Dashboard Trellis 视图，确认本仓库
  .specrune 任务自动出现、徽标显示、详情/归档可开（实现会话运行在该 app
  内，无法自杀重启验证）。

## 风险文件 / 回滚点

- src/trellis-activity.js（最大回归面 — 每步跑 node --test）
- src/main.js（注册/广播段 :2529-2731、:5530-5610）
- src/session-ipc.js、src/trellis-roots.js、src/dashboard-renderer.js、
  src/dashboard.html、src/i18n.js
- 回滚：整任务单 commit revert；specrune-roots.json 残留无副作用。

## 开工前检查

- [ ] 两份 research 文件在 manifest 中（implement/check）。
- [ ] 对照当前 src 实际导出写测试（旧测试有死导入先例）。
- [ ] 确认本机 .specrune/ fixture 数据可用于手动验证。
