# WDX Relief 开发与验证

![0.3.0 的插件配置页](bundle-config.webp)

> 截图为 0.3.0；0.3.1 起配置页改为「先编辑、再保存」，底部会多出保存按钮。

## 独立 web profile 安装

```bash
export DSH_HOME=/tmp/dsh-relief-dev
dsh web --no-open --port 0          # 首次会生成 profile
dsh plugin --profile web add link:/path/to/dsh-wdx-relief
```

把 `dsh-wdx-relief` 加进 `$DSH_HOME/profiles/web/package.json` 的
`dsh.profile.bundles`（放在 `@deepseek-ai/dsh-web-app` 之后），重启 `dsh web`。

## 配置页在哪里

配置页通过 `ctx.slots.inject('plugins.bundle.config', …)` 注册，key 是包名 `dsh-wdx-relief`；
`dsh.client.inject` 因此声明 `@deepseek-ai/dsh-client-ui-plugin-manager`；同时保留
`@deepseek-ai/dsh-client-ui-settings`（`configForms` 的提供方）和 `@deepseek-ai/dsh-client-ui-sidebar-right`
（右侧栏页面与 `sidebarRightTabs` 的提供方）。插件管理页加载后，bundle 页面在 README 下方渲染这个 keyed slot；插件关闭时
整个浏览器半身卸载，配置页也随之消失。

所有字段都是 Host `Config` 的 `.volatile()` 引用。客户端用
`SettingsFormModel(ctx.configForms.get('wdx-relief'), …)` 暂存编辑，点 **保存** 才通过
`form.mutate()` 写入；离开页面会丢弃未保存草稿。写入落到 profile 的 `cordis.patch.yml`，
HMR 生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 输入框预测开关 |
| `recap` | `true` | 语义摘要开关：每几轮用一次便宜模型写「现在到哪」 |
| `recapActivity` | `false` | 活动流水开关：读文件 / 跑命令 / 改代码，本地生成 |
| `recapTiming` | `false` | 状态耗时开关：这一轮跑了多久，本地生成 |
| `recapReasoning` | `false` | 思考预览开关：折叠推理的第一行，本地生成 |
| `recapPlacement` | `above` | `above` / `below`，这一行放在输入框上方还是下方 |
| `recapMinTurns` | `3` | 至少几轮用户消息后才开始生成语义摘要 |
| `recapCooldownTurns` | `3` | 每隔几轮更新一次语义摘要；`1` = 每轮 |
| `recapSimilarityThreshold` | `0.7` | 新旧摘要相似度达到这个值就沿用旧的一行 |
| `recapMaxWords` | `40` | 摘要词预算；中文按字算 |
| `recapModelChain` | `''` | 摘要模型链，按顺序尝试 `provider/model`；留空自动挑便宜模型 |
| `today` | `true` | 右侧栏 WDX Relief 页面里的「待跟进」清单 |
| `verbosity` | `low` | `low` / `medium` / `high`（旧值 `model` 仍兼容） |
| `actionable` | `true` | 便于行动：先结果/下一步、白话解释术语、保留风险 |
| `style` | `default` | `default` / `professional` / `friendly` / `blunt` / `follow` |
| `customInstructions` | `''` | 最多 2000 字 |

旧版本的 `writingStyle` / `baseStyle` 仍保留在 schema 里做迁移：没有 `style` 时，`writingStyle: true` 映射为 `follow`，`baseStyle` 的 professional/friendly/blunt 映射到同名风格；设置页只写新的 `style`。

bundle 层只声明入口和输入层的开关，其余字段由 schema 默认值提供：

```yaml
- insert:
    - id: wdx-relief
      name: dsh-wdx-relief
      config:
        enabled: true
        recap: true
        recapActivity: false
        recapTiming: false
        recapReasoning: false
        recapPlacement: above
        today: true
```

## 输入预测

1. 客户端注册在 `conversation.input.overlay`，观察 `useSession.running`、`useInput` 和设置；
   空闲、空输入时以 350ms 防抖请求 `POST /api/wdx-relief/predict`。
2. Host 用 `ctx.sessions.get(sessionId).deriveMessages()` 取最近几轮真人用户/助手文本，
   要求最后一条是助手消息；用 `agentDefaultModel` 的最低推理档位生成一条短句。
3. 结果按 `session.seq` 缓存；客户端把灰字绝对定位到 `[data-composer-input]` 的文字起点，
   Tab 通过标准 prop `inputActions.setDraft()` 写入 Lexical 编辑器。
   这条 Codex 式体验依赖 composer 的布局矩形，是本插件已知的 DOM 耦合点。

## 输入框上的一行

这一行是**逐轮**的，不是会话级的；它回答「这一轮在做什么、到哪了」。四种语义各有独立开关，默认只开语义摘要，避免和 transcript 里已有的工具卡片、耗时、推理重复交叉：

| 片段 | 来源 | 成本 |
|---|---|---|
| 活动流水 | `session.binding.eventSource` 里的 `tool/call`、`tool/result`、步骤事件 | 本地，零调用 |
| 状态耗时 | `turn/start` 的 `time` 与当前时间 | 本地，零调用 |
| 思考预览 | `assistant/live-chunk` 的 `reasoning-delta`，取最后一个完整段落的第一行 | 本地，零调用 |
| 语义摘要 | `POST /api/wdx-relief/recap`，Host 用便宜模型概括最近一轮 | 每 `cooldownTurns` 轮一次 |

1. 客户端同时注册 `conversation.input.dock`（上方）和 `conversation.composer.dock`（下方），
   按 `recapPlacement` 只渲染其中一个，并且只有匹配的那个会发起摘要请求；两边是同一个组件。
2. 活动 / 耗时 / 思考只读 `ctx.sessions.binding(sessionId).eventSource`；窗口变化时 React
   重算，运行中每秒刷新耗时。**不写会话、不写命令日志、不注入 prompt**。
3. 轮次结束后，客户端按 `sessionId + turn` 去重请求一次回顾。Host 只读
   `session.deriveMessages()`，取最近一轮真人用户/助手文本，按下列门限决定是否真的调用模型：
   - `minTurns`：用户消息不足时返回 `skipped: 'min-turns'`；
   - `cooldownTurns`：距离上次生成不足 N 轮时返回 `skipped: 'cooldown'`，沿用上一行；
   - `similarityThreshold`：新摘要与已显示的摘要词集合 Jaccard 相似度达到阈值时沿用上一行；
   - `maxWords`：按混排词预算截断，中文按字、英文按词。
4. 模型链先按 `recapModelChain` 里的 `provider/model` 顺序尝试；裸模型 id 会先在默认 provider
   下解析，再查各 provider 的目录。没有配置时，从目录里挑名字带 `flash` / `mini` / `lite` /
   `haiku` 等词的模型，最后退回 `agentDefaultModel.currentSelection()`。某个模型失败（凭据缺失、
   限流、截断）会继续试下一个；全部失败时退回「要求 · 结果」的本地短拼接，并在响应里带
   `degraded: true`。
5. 模型写了半句就停时（没有句末标点，且最后一个分句只剩 1-2 个字，例如
   `…表前缀已替换，待`），先在同一模型上重试一次；仍不完整就截到最后一个分句边界并补省略号。
   流式响应没有 `finish` 事件也按失败处理，继续试下一个模型或退回本地拼接，避免把半句留在面板上。
6. 摘要按轮次内容缓存；同一条 `(turn, user, assistant, question)` 只生成一次。
   真正生成的新摘要追加到 `$DSH_HOME/wdx-relief/recaps.json`（最多 300 条），
   右侧 WDX Relief 页面的「会话回顾」Tab 通过 `POST /api/wdx-relief/recaps` 读取；
   Tab 顶部显示条数，可「清空」当前会话的历史（body 带 `clear: true`）。
   重复摘要（重启后同一轮重新生成、文字没变）不会再记一条。

这一行不读工作区文件，也不解释长报告的全部细节；它只概括最近一轮的要求与结果。
语义摘要走 `ctx.llm.stream`，不 append 消息、不进入下一次模型请求。

## 旁问

旁问不再是 composer 命令，而是右侧栏 WDX Relief 页面的「旁问」Tab；默认 Tab 是「待跟进」。

- 输入框和 composer 使用同一套视觉：圆角卡片、底部模型位、右侧圆形发送/停止按钮。按 <kbd>⌘/Ctrl + Enter</kbd> 也可以发送。
- 底部模型位来自会话级模型目录（`ctx.modelDirectories`）。默认跟随当前会话模型；选中别的模型只影响这次旁问，**不会改变主会话模型**。宽度不够时模型名收成数据图标，只保留图标和下拉箭头。
- 客户端调用 `POST /api/wdx-relief/btw`（body: `sessionId` + `question`，可选 `provider` / `model`）。Host 用面板传来的模型；没传时用
  `ctx.agents.get(sessionId).model.current()`，没有实时 agent 时退回默认模型。
- 背景只取 `session.deriveMessages()` 的最近 6 条真人用户/助手文本，限制总长度。
- **不写会话、不写命令生命周期、不 append 消息**：这次问答不会出现在 transcript，也不会进入下一次模型请求。
- 回答仅存在面板内存里，关闭面板或切换会话就清空；正在回答时可以停止，Host 侧超时 30 秒。
- 没有打开会话时显示「先打开一个会话」，不发送请求。
- 如果运行中的 Host 还没加载新路由，面板会提示「旁问路由未加载；请重启 DSH 后再试」，而不是裸露 HTTP 404。

## 右侧栏 WDX Relief 页面

插件在右侧栏注册一个独立页面（`sidebarRightTabs.register`，`kind: wdx-relief`），入口和 WDX Git 一样出现在右侧栏的工具列表（`guide.order 35`）。页面用三个 Tab：默认「待跟进」、「会话回顾」、「旁问」；后续小功能继续加 Tab，不平铺。

### 待跟进的事

目标：把过去会话里「助手提醒过你、但你之后没有回应」的事整理成清单。

- 取数只读尾部：同一工作区、14 天内、空闲超过 2 小时的会话，每个取最后一条助手消息（≤800 字）；
  最后一条是用户消息的会话跳过——那是助手没回，不是用户漏了。
- 确定性部分只做筛选，不算「有没有漏」；由一次模型调用（`POST /api/wdx-relief/today`）判断哪些需要你决定，
  并要求它只输出 JSON、不许新增输入里没有的事。
- **模型失败时退回关键词清单**（问句 + 「还未/未推送/等你确认」这类硬信号），响应带 `degraded: true`，
  页面如实标注「模型没整理成功，这份是按关键词挑的」。
- 结果按工作区 + 会话集合缓存 15 分钟；面板的刷新按钮带 `x-wdx-force: 1` 跳过缓存。跨会话重复的事由模型合并，最多 5 条。
- 当前会话的 `cwd` 先取 live 会话，取不到再从会话列表里找，避免刚恢复的历史会话打不开。
- 依赖 `ctx.sessionQuery`（base profile 已挂 `session-query-sqlite`）；缺失时显示「无法整理」。
- 点条目用 `uiWorkspace.openSession()` 跳回原会话。
- 每条右侧的「×」是**清掉**：记进 `$DSH_HOME/wdx-relief/followups.json`，之后不再出现在清单里，
  旁边留一个「撤销」可放回。清掉只作用于面板，不删会话里的任何内容。
- 去重口径是「会话 + 归一化文本」：标点、空白、大小写不参与比对；同一会话里模型换个说法（相似度 ≥0.6）
  也算同一条，但英文词和数字必须一致，`PR #12` / `PR #13`、`v0.4.0` / `v0.5.0` 不会被合并。
- 清掉 / 撤销分别走 `POST /api/wdx-relief/today/dismiss`、`POST .../restore`，返回 `{ changed }`；
  清掉清单最多留 200 条，超出丢最旧的。
- 过滤发生在返回前，服务端的模型结果缓存始终保留原样，所以清掉一条不会触发重新整理。

## 回复风格

Host 在 `ctx.systemPrompt` 注册：

```js
{
  name: 'wdx-relief:reply-style',
  order: 10300,
  interpolate: false,
  text: () => buildStylePrompt(config),
}
```

`buildStylePrompt` 只输出非默认项，并加一段“只影响表达方式”的前缀。自定义指令最多 2000 字；
`interpolate: false` 让其中的 `{{...}}` 保持字面量，避免 prompt 装配报错。

「便于行动」规则改编自 `agent-configs-skills/skills/i-have-adhd`（MIT）：开头给结果/下一步、
按内容比例组织（句 > 段 > 清单）、术语先用白话说明、保留风险与失败条件、不复述、
不把已获授权的工作交回用户。

## 实机验证记录（DSH 0.2.2-rc.1，历史配置页）

- 侧边栏「插件」→ **WDX Relief** bundle 页出现配置区：输入开关、回复长度、便于行动开关、回复风格、自定义指令；
- 下拉框、开关、textarea 均可写入；关闭再打开设置后保持；`--dump-config` 能看到 `verbosity`、`actionable`、`style`、`customInstructions`；
- Settings 导航不再出现「回复」，General 不再出现预测行（已迁移到插件配置）；
- 输入框灰字出现、打字隐藏、清空重现，Tab 真正写入 Lexical；
- 关闭预测开关后不再发预测请求；
- Host 日志确认预测路由与 `wdx-relief:reply-style` prompt section 注册成功；
- Node 单测通过。


## 0.3.1 验证

- `conversation.input.overlay` 下 `wdx-prediction`（registrant `wdx-relief`，active）；保持 Codex 式输入框灰字。
- `plugins.bundle.config` 下 `dsh-wdx-relief` 条目仍 active。
- 配置页改用 `SettingsFormModel` 暂存、`SettingsForm` 保存；`node --test` 27 项通过。
- `npm pack --dry-run` 确认 `client/client.js`、`locale`、`icon.svg`、`cordis.patch.yml` 都在发布文件里。
- 浏览器内交互（实际点击、保存、开关、Tab）尚未在本次会话中用浏览器控制复核。

## 0.4.0 验证

- Host 日志出现 `POST /api/wdx-relief/recap`、`POST /api/wdx-relief/today` 与 `POST /api/wdx-relief/btw` 注册；
- 客户端注册面新增 `conversation.input.dock` / `conversation.composer.dock` 的 `wdx-turn-line-*` 与右侧栏 `sidebar.right.pane.tab` 的 `wdx-relief` 页面；
- 旁问面板默认展示「待跟进」Tab，模型位读取 `ctx.modelDirectories`，选中只影响旁问；
- `node --test` 覆盖回顾提取 / minTurns / cooldown / 相似度门限 / 模型链、旁问提示词/回答/错误/模型覆盖、今日清单、客户端事件推导与注册面；
- 浏览器内实际轮次切换、两种 placement、旁问 Tab 与 Markdown 渲染尚未在本次会话中用浏览器控制复核。

## 已知限制

- 回复风格是 prompt 软约束，不是硬截断；复杂任务仍可能写长。
- 语义摘要依赖一次模型调用；模型失败时退回本地短拼接，且**失败结果不缓存、不写历史**，下一轮会重试。活动流水 / 耗时 / 思考预览不受影响。
- 「会话回顾」历史存在本地 `$DSH_HOME/wdx-relief/recaps.json`，最多 300 条；换机器或清空该文件即清空历史。
- 旁问只把最近几轮文本作为背景；它不会读取工作区文件，也不会自动带上未提交的改动。
- 旁问默认使用当前会话模型，也可以在面板底部选别的模型；选择只影响这一次/这一组旁问，不改主会话模型。
- 没有实时 agent 时退回默认模型，两者都没有时返回面板错误。
- 每次旁问独立：上一次旁问的问答不会成为下一次背景（它们本来就不在会话里）。
- 旁问的回答只存在面板内存里，不跨刷新/重开保留；这是为了不把问答写进任何持久存储。
- 写作风格只看当前对话；没有跨会话风格档案，也不读取工作区文件或外部应用。
- 风格设置全局生效，暂不支持 per-session。
- 灰字定位依赖 composer 的 DOM 属性（`data-composer-card/input/placeholder`），DSH 改版时需要同步。
