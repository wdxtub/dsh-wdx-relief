# WDX Relief

降低 DSH 日常使用心智负担的小功能集合。目前两个功能，**全部设置都在这个插件的配置里**。

> 侧边栏 **插件 → 已安装插件 → WDX Relief**，配置区在 bundle 页面下方。
> 不往 DSH 的 Settings 导航里插入页面；字段都是插件自己的 `Config`，写入后持久化到 profile 的 `cordis.patch.yml`。

## 功能

- **输入框下一句预测**：对话结束后用灰字猜你接下来要发的话，<kbd>Tab</kbd> 填入；打字隐藏，<kbd>Esc</kbd> 忽略。
- **回复风格**：长度 **短 / 标准 / 详细**；风格 **默认 / 专业 / 亲和 / 直接 / 跟随我的风格**；可加最多 2000 字的自定义指令。
- **便于行动**（默认开启）：先给结果和下一步；能一句说清的不写一段，术语先用白话说明；保留风险、失败条件和已授权该做的工作。

## 安装

在 DSH 侧边栏 **插件 → 添加插件** 输入：

```text
dsh-wdx-relief
```

或让 agent 调：

```text
plugin_manager install_bundle target = "dsh-wdx-relief"
```

安装后启用并刷新页面。

本地开发时用 `link:` 安装当前目录的方式见 [docs/guide.md](docs/guide.md)。

## 开发

```bash
pnpm install
pnpm test
```

完整的配置字段、实现细节、独立 web profile 安装方式和实机验证记录见 [docs/guide.md](docs/guide.md)。