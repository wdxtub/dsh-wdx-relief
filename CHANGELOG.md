# Changelog

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
