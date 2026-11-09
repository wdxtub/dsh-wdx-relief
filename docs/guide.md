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
`@deepseek-ai/dsh-client-ui-settings`，因为 `configForms` 由它提供。插件管理页加载后，bundle 页面在 README 下方渲染这个 keyed slot；插件关闭时
整个浏览器半身卸载，配置页也随之消失。

所有字段都是 Host `Config` 的 `.volatile()` 引用。客户端用
`SettingsFormModel(ctx.configForms.get('wdx-relief'), …)` 暂存编辑，点 **保存** 才通过
`form.mutate()` 写入；离开页面会丢弃未保存草稿。写入落到 profile 的 `cordis.patch.yml`，
HMR 生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 输入框预测开关 |
| `verbosity` | `low` | `low` / `medium` / `high`（旧值 `model` 仍兼容） |
| `actionable` | `true` | 便于行动：先结果/下一步、白话解释术语、保留风险 |
| `style` | `default` | `default` / `professional` / `friendly` / `blunt` / `follow` |
| `customInstructions` | `''` | 最多 2000 字 |

旧版本的 `writingStyle` / `baseStyle` 仍保留在 schema 里做迁移：没有 `style` 时，`writingStyle: true` 映射为 `follow`，`baseStyle` 的 professional/friendly/blunt 映射到同名风格；设置页只写新的 `style`。

bundle 层只声明入口和预测开关，其余字段由 schema 默认值提供：

```yaml
- insert:
    - id: wdx-relief
      name: dsh-wdx-relief
      config:
        enabled: true
```

## 输入预测

1. 客户端注册在 `conversation.input.overlay`，观察 `useSession.running`、`useInput` 和设置；
   空闲、空输入时以 350ms 防抖请求 `POST /api/wdx-relief/predict`。
2. Host 用 `ctx.sessions.get(sessionId).deriveMessages()` 取最近几轮真人用户/助手文本，
   要求最后一条是助手消息；用 `agentDefaultModel` 的最低推理档位生成一条短句。
3. 结果按 `session.seq` 缓存；客户端把灰字绝对定位到 `[data-composer-input]` 的文字起点，
   Tab 通过标准 prop `inputActions.setDraft()` 写入 Lexical 编辑器。
   这条 Codex 式体验依赖 composer 的布局矩形，是本插件已知的 DOM 耦合点。

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

## 已知限制

- 回复风格是 prompt 软约束，不是硬截断；复杂任务仍可能写长。
- 写作风格只看当前对话；没有跨会话风格档案，也不读取工作区文件或外部应用。
- 风格设置全局生效，暂不支持 per-session。
- 灰字定位依赖 composer 的 DOM 属性（`data-composer-card/input/placeholder`），DSH 改版时需要同步。
