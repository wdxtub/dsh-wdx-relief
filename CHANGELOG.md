# Changelog

## 0.4.0 — 2026-11-11

- 新增 **输入框上的一行**（默认开启）：逐轮显示「这一轮在做什么、到哪了」，不再是「离开三分钟后」的会话级回顾。
  - 四种语义独立开关：活动流水（`recapActivity`）、状态耗时（`recapTiming`）、思考预览（`recapReasoning`）、语义摘要（`recap`）。默认只开语义摘要，回到旧版一行概括的观感；前三项只读事件窗口，本地生成、零模型调用，需要时再打开，避免与会话里已有的工具卡片/耗时/推理重复交叉。
  - 摘要参考 `@lanlance/pi-recap` 的门限：`recapMinTurns`（默认 3）、`recapCooldownTurns`（默认 3）、`recapSimilarityThreshold`（默认 0.7）、`recapMaxWords`（默认 40，中文按字算）；`recapPlacement` 可选输入框上方 / 下方。
  - `recapModelChain` 支持按顺序尝试 `provider/model`；留空自动挑便宜模型（flash / mini / lite / haiku 等），最后退回默认模型。模型失败时退回本地短拼接，并带 `degraded`。
  - 这一行是纯 UI：只读 `deriveMessages()` 与事件窗口，模型调用走 `ctx.llm.stream`，不写会话、不注入 prompt、不进入模型上下文。
- 右侧栏 WDX Relief 页面改为 Tab：默认「没接住的事」，「旁问」单独一个 Tab，不再平铺。
- 旁问输入框改为 composer 风格：圆角卡片、底部模型位、右侧圆形发送/停止按钮；模型位来自 `ctx.modelDirectories`，选中的模型只影响旁问，不改主会话。宽度不够时模型名收成数据图标，只保留图标和下拉箭头。
- 移除旁问面板里重复的「不写入上下文」徽标和「只留在面板…」提示。
- 新增 **右侧栏「旁问」**：输入问题后用当前会话模型（或面板选的模型）回答，背景只取最近几轮文本；问答只存在面板内存里，不写会话、不写命令日志，也不进入模型上下文。
- 新增 `POST /api/wdx-relief/recap` 与 `POST /api/wdx-relief/btw`；旁问路由复用 `src/btw.js`，不产生命令生命周期。
- 旧 Host 未加载旁问路由时，面板显示「旁问路由未加载；请重启 DSH 后再试」，不再直接暴露 HTTP 404。
- `dsh.client.inject` 增加 `dsh-client-ui-sidebar-right`；Host 依赖保持 `connection` 与 `sessions`，不再注册 composer `/btw` 命令和 transcript 卡片。
- 更新 README、开发文档和 bundle 默认配置。

## 0.3.2 — 2026-11-09

- 修复：Tab 填入预测后把输入删空，建议不会重新出现；现在只收起当前建议，同一轮缓存会重新给出，Esc 仍忽略本轮。

## 0.3.1 — 2026-11-09

- 保留 Codex 式输入框灰字预测：建议仍注册在 `conversation.input.overlay`，不改成输入框外的一行。
- 样式改为随 React 组件挂载/卸载，移除模块级 `document.head` 副作用；移除内联颜色 fallback。
- 配置页改用官方 `SettingsFormModel` + `SettingsForm`：编辑先暂存，点「保存」才写入；离开页面丢弃草稿。
- 修正 `dsh.client.inject`：补上 `ui-plugin-manager`，保留 `ui-settings`（`configForms` 的提供方）；移除 `immediately`。
- 打包元数据：`@deepseek-ai/schemastery` 改为运行时依赖；Cordis 保持 peer/dev 同范围；`engines.dsh` 增加 `<0.3.0` 上界；图标改用 SVG。
- 修正 RELEASING.md 中被占位符替换的版本示例。

## 0.3.0 — 2026-11-09

- 精简回复设置：长度 3 档（短/标准/详细）；风格 5 选 1（默认/专业/亲和/直接/跟随我的风格）；保留「便于行动」开关和自定义指令。
- 删除 5 个细节轴（亲切、热情、表情、可视化、标题列表）和独立的「参考我的写作风格」开关，避免预设与轴、开关与轴互相冲突。
- 旧配置兼容：`writingStyle: true` 映射为「跟随我的风格」，旧 `baseStyle` 的 professional/friendly/blunt 映射到同名风格。

## 0.2.0 — 2026-11-09

- 新增「便于行动」输出模式（默认开启）：先给结果/下一步、按内容比例组织、术语先用白话说明、保留风险与失败条件、不复述、不把已授权工作交回用户。规则改编自 `agent-configs-skills/skills/i-have-adhd`（MIT）。
- 设置页「写作」组新增「便于行动」开关；关闭后只保留长度、语气和自定义指令。

## 0.1.0 — 2026-11-09

首个公开版本。

- **输入框下一句预测**：对话结束后在 composer 里用灰字预测下一句，Tab 填入，Esc 忽略；只在空闲、空输入、助手消息落盘后触发，按轮次缓存。
- **回复风格**：默认简短；可调输出详细程度、参考当前对话的写作风格、基础风格预设、亲切程度、热情程度、表情符号、可视化回答、标题和列表，以及 2000 字以内的自定义指令。
- 所有设置位于侧边栏 **插件 → 已安装插件 → WDX Relief** 的 bundle 配置区，不向 Settings 导航插入页面；配置写入 profile 的 `cordis.patch.yml`，HMR 生效。
- 回复风格通过 `ctx.systemPrompt` 的 order `10300` section 注入，只输出非默认项；自定义指令以 `interpolate: false` 注册。
- 预测使用默认模型的最低推理档位，15 秒超时；模型不可用或失败时静默隐藏。
- 深浅色主题自适应的设置页与下拉菜单；自定义 WDX Relief 图标。
