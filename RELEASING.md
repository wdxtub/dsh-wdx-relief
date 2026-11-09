# 发布 WDX Relief

发布分两步：**先发 npm，再让 DSH 从 npm 安装/更新**。

## 一次性准备

1. 注册 npm 账号并开启 2FA。
2. 登录 npm 官方源（镜像不能发布）：

   ```bash
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

3. 确认包名可用：

   ```bash
   npm view dsh-wdx-relief version --registry=https://registry.npmjs.org/
   ```

   返回 404 才表示可用；如果被占用，把 `package.json` 的 `name` 改成
   `@wdxtub/dsh-wdx-relief`，并同步改本文命令。

## 浏览器 2FA 发布（固定方式）

npm 账号开启了 `auth-and-writes` 2FA，非交互运行 `npm publish` 会直接报 `EOTP`。
本仓库用 `expect` 提供 PTY，让 npm 走浏览器认证：

```bash
expect scripts/publish-npm.exp > /tmp/npm-publish-pty.log 2>&1 &
tail -f /tmp/npm-publish-pty.log
```

看到 `AUTH_BROWSER_OPENED` 后，在浏览器的 npm 认证页完成 2FA/Passkey；npm 会自动
取到 OTP 并继续发布。不要重复启动另一个发布。没有浏览器窗口时，从日志里取出
`https://www.npmjs.com/auth/cli/...` 手动打开。

## 首次发布

先提交干净（`npm version` 需要干净的工作区）：

```bash
git add .
git commit -m "feat: initial WDX Relief release"
npm test
npm pack --dry-run

# 可选但推荐：把 tarball 装进 DSH 走一遍真实安装
npm pack
# 插件页 → 添加插件 → 输入 tarball 绝对路径 → 安装 → 立即启用

expect scripts/publish-npm.exp
git tag -a v0.1.0 -m "v0.1.0"
git push origin main --tags
```

发布后验证：

```bash
npm view dsh-wdx-relief version --registry=https://registry.npmjs.org/
```

## 后续版本

- **patch**：修复 bug、文案、兼容性小修；
- **minor**：新功能，0.x 阶段也用它；
- **major**：破坏性变更。

```bash
git status
# 更新 CHANGELOG.md 并提交
npm test
npm version minor -m "chore: release v%s"
expect scripts/publish-npm.exp
git push --follow-tags
```

预发布：把 `scripts/publish-npm.exp` 里的 `npm publish` 参数改为 `--tag next`，
或直接运行：

```bash
npm version 0.2.0-rc.1
npm publish --tag next --access public --registry=https://registry.npmjs.org/
npm dist-tag add dsh-wdx-relief@0.2.0-rc.1 latest --registry=https://registry.npmjs.org/
```

## DSH 里安装新版本

插件页 → **添加插件** → `dsh-wdx-relief`（或精确版本 `dsh-wdx-relief@0.1.0`）→ 安装 → 立即启用。

或让 agent 调：

```text
plugin_manager: action=install_bundle, target=dsh-wdx-relief
```

如果之前用本地 `link:` 或 tarball 装过开发版，插件页会视为已安装，直接装 npm 包会报
`already-installed`；先在插件页移除旧版本，再安装 npm 包。

## 注意

- npm 发布只保证能按包名安装；不会自动进入官方「发现」目录。
- `engines.dsh` 声明兼容的 DSH 版本；不满足时 DSH 会在安装前拒绝。
- 版本号发布后不可复用；有问题的版本只能 deprecate，再发新版本。
