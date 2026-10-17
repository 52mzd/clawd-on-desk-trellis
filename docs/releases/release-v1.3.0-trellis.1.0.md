# Clawd on Desk v1.3.0-trellis.1.0

> **这是 fork 的版本。** 基于上游 `v1.3.0` 的同步版本。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本版本内容(自 v1.2.0-trellis.1.3)

同步上游 v1.3.0 全部 2064 个提交,Trellis 定制功能全部保留。

### DeepSeek Harness:新增,支持 0.1 与 0.2 两个小版本族

DSH 集成是上游 v1.3.0 的主要新功能,本 fork 首次随版本提供:

- **web 与桌面版双载体**:`dsh web` 与 DeepSeek Harness 桌面 App 各自一个 profile,
  在 Settings 与 Doctor 里合并成**一行**管理;
- **版本门禁改为小版本族**:`0.2` 族放行 `>=0.2.0-rc.2 <0.3.0-0`,`0.1` 族放行
  `>=0.1.0-rc.6 <0.2.0-0`。同族内不同 host 版本共用一个 generation。
- **点击桌面版会话可直接唤起 App 窗口**(不选中具体对话)。

### 其它上游更新

- **Claude Code**:工具批次之间回到 thinking(需 2.1.280+)、会话标题显示、`/design` 设计反应;
- **Codex**:审批默认改为 **Auto**(旧的 Intercept/Native 会一次性迁移)、compaction 支持、
  会话卡片与原生标题;
- **WorkBuddy**:会话卡片生命周期、原生标题、context usage;
- 配额提醒 ring、官方主题离线可用、宠物缩放、Footprints、Linux AppImage 关闭修复。

## ⚠️ 升级说明(重要)

- **Codex 审批模式会变**:升级后 Intercept / Native 会**一次性迁移到 Auto**。若你依赖 Clawd
  接管审批,请到 Settings → Agents → Codex 重新选 **Intercept**(升级后的选择会被保留)。
- **DSH bridge 升级后需重启**:已安装的 DSH bridge 会在升级后更新一次 generation。重启正在运行的
  `dsh web` 与桌面 App 才会生效。
- **不支持降级**:v1.2.0 无法读取 v1.3.0 的偏好设置,其 DSH 安装器也认不出新的 family marker。
  如需手动清理由 `dsh plugin remove @dsh-external/dsh-clawd-bridge` 完成。
- Cloudling 主题在同一滑块位置下**视觉尺寸约小 29%**(上游行为),可上调滑块补偿。

## 本 fork 的已知修正

上游 v1.3.0 的 `settings-choice-electron` 测试把侧栏 tab 数写死为 10,而本 fork 多一个
**Trellis** tab。已改为从渲染后的侧栏推导数量,避免以后新增 tab 再次误报。

## 版本说明

这是私有 fork 构建(`1.3.0-trellis.1.0`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.3.0` **之前**;不发布到官方 release 渠道或 winget。
