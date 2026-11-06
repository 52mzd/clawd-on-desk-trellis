# Clawd on Desk v1.5.0-trellis.1.0

> **这是 fork 的版本。** 基于上游 `v1.5.0` 的同步版本。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本版本内容(自 v1.3.0-trellis.1.0)

同步上游 `v1.4.0` 与 `v1.5.0` 之间的 262 个提交,fork 定制功能全部保留。

### 设置与省电

- **设置拆成五个标签页**:通用 / 桌宠 / 通知 / 会话 / 权限与审批,原有取值保留,
  旧的 Remote approval 入口跳到「IM 通道」子页;
- **无人时休眠**:离开后桌宠短暂走动再睡着,倒下与睡眠姿势停止动画;
- **对象通道渲染与 24 步采样**:thinking / long-lived / typing / building 走
  `<object>` 与离散采样网格,外观不变而 CPU 大幅下降;深睡默认暂停动画;
- 主题可声明 `rendering.objectChannelFiles` / `rendering.svgChannel` /
  `rendering.discreteSampling` 选择加入。

### 权限与手机

- **可选外部复核命令**:自动放行前跑一条用户配置的 argv 命令,退出码 0 才放行,
  其余结果(含超时)回到人工卡片;默认关闭;
- **每台手机独立配对**:配对码一次性、10 分钟有效,可逐台撤销,也可撤销旧共享 token;
  手机预览默认关闭;手机消息上限 4,096 字节;
- **只读手机权限摘要**,手机仍不能批准或拒绝。

### 代理集成

- **Codex 委派子代理动画**:子代理工作时桌宠戴耳机 / 抛接,完成提示等最后一个子代理
  真正结束后只播一次;只影响本机会话;
- **Codex 临时对话**:已确认的临时对话不再尝试恢复失败链接,可用两个开关从 HUD 折叠;
- **Codex 计划进度**:HUD 与 Dashboard 显示步骤进度条;
- **Kiro Desktop** 状态钩子与只读审批提醒;**Copilot** 在终端等待时让桌宠等待并提醒;
- **Remote SSH 支持 Windows 远程主机**,并可为 Windows 远程主机安装 Codex 钩子。

### Linux 更新

`.deb` 安装改为通过官方 APT 源更新,按钮变为「Update with APT」并打开迁移指南;
AppImage 保留应用内更新。

### fork 侧变更

- **SpecRune 迁移**:本地工作流从 `.trellis/` 迁到 `.specrune/`,pi 扩展与提示词同步替换;
- **Dashboard 识别 `.specrune` 工作流根**,SpecRune 任务看板可与 Trellis 混排;
- trellis-panel-contract 补充 workflow 载荷字段的跨层契约与双 workflow 目录约定。

## ⚠️ 升级说明(重要)

- **Codex 审批设置改写**:Settings 里原来的 Codex Auto/Intercept 选择器换成
  Advanced 开关,升级后请到 Settings → 权限与审批重新确认;
- **Linux `.deb` 用户**:旧的应用内更新可能失败;按 [迁移指南](https://apt.clawdondesk.com/#chinese)
  接入一次官方源即可,更新前先退出 Clawd;
- **手机配对会失效**:旧共享 token 在重置手机访问后作废,所有设备需要重新配对;
- **不支持降级**:v1.3 无法读取 v1.5 的偏好设置。

## 版本说明

这是私有 fork 构建(`1.5.0-trellis.1.0`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.5.0` **之前**;不发布到官方 release 渠道或 winget。
