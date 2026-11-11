# 发布 WDX Relief

本文给维护者用。发布分两步：**先发 npm，再让 DSH 安装/更新**。
整条流程固定在 `npm run release`（`scripts/publish-npm.sh`），和 WDX Git 同一套。

## 一次性准备

1. 注册 npm 账号并开启 2FA。
2. 登录 npm 官方源（不是 npmmirror，镜像不能发布）：

   ```bash
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

3. 确认发布状态：

   ```bash
   npm view dsh-wdx-relief dist-tags --json --registry=https://registry.npmjs.org/
   ```

   包已存在（当前 `latest` 为 0.3.2）。首次发布才需要 404 检查；若包名被他人占用，
   把 `package.json` 的 `name` 改成 `@wdxtub/dsh-wdx-relief`，并同步替换本文命令。

4. 工作区要干净（`git status`）。`npm version` 和发布脚本都依赖这一点。

## 发布：`npm run release`（本仓库的固定方式）

发布走浏览器 2FA，不收集 OTP：

```bash
npm run release -- --check   # 预检：工作区、版本、测试、打包、登录
npm run release              # 登录（如需要）→ 浏览器验证 → 发布 → 等 registry 同步
```

`npm run release` 会：

1. 要求工作区干净，并确认 `package.json` 版本尚未发布；
2. 跑 `npm test` 和 `npm pack --dry-run`；
3. `npm whoami` 失败时，用浏览器登录并等待用户完成验证；
4. 用 PTY 跑 `npm publish`；看到 `Press ENTER` 自动回车并打印认证 URL，
   等待用户在浏览器完成 2FA/Passkey，然后自动继续；
5. 认证类失败（401 / E401 / EOTP）自动重新登录并重试一次；
6. 轮询 registry 直到该版本和 `dist-tags.latest` 都能查到，再打印 tarball。

脚本不 commit、不 tag、不 push；这些仍由你确认后执行。

关键点：

- 不要直接非交互运行 `npm publish`：stdin 不是 TTY 时会抛 `EOTP`，auth URL 会被打码。
- 必须给 PTY；`expect` 的 `spawn` 提供它。`scripts/publish-npm.exp` 只匹配
  `Press ENTER` / `+ <包名>@<版本>` / `Published` / `npm error`，不会误杀测试输出。
- 看到 `AUTH_BROWSER_OPENED` / `LOGIN_BROWSER_OPENED` 后，等用户在浏览器完成认证；
  不要另起一个发布进程。
- 如果浏览器没自动打开，从输出里取出 `https://www.npmjs.com/auth/cli/...`
  或 `https://www.npmjs.com/login?...` 让用户手动打开。
- 发布成功后脚本会等 registry 同步；新包第一次可能出现 `0.0.0-stage` 占位。
- `--check` 在版本已发布时会给出警告并继续检查，便于发布后复验环境。

> 2FA 验证码在用户自己的验证器 App 里（1Password / Google Authenticator / Authy 等），
> npm 不会发短信/邮件。不要向用户索要验证码；优先走浏览器认证。只有用户主动提供
> OTP 时才可以用 `npm publish --otp=...`。

`publishConfig` 已指向 npm 官方源，脚本也显式带 `--registry`，不受本机镜像配置影响。
先发 npm 再打 tag 也可以；tag 只是标记发布对应的代码。

## 后续版本

语义化版本：

- **patch**：修复 bug、文案、兼容性小修；
- **minor**：新功能，0.x 阶段也用它；
- **major**：破坏性变更。

```bash
git status                       # 必须干净
# 先更新 CHANGELOG.md，并提交它
npm version patch -m "chore: release v%s"
npm run release -- --check       # 可选：先预检
npm run release                  # 浏览器 2FA → 发布 → 等 registry
git push --follow-tags
```

`npm version` 会更新 `package.json`、创建 release commit 和 `vX.Y.Z` tag。
`npm run release` 不自动 commit / tag / push；发布后如需补 tag，再执行
`git tag -a vX.Y.Z -m "vX.Y.Z"`。
在 GitHub 上基于该 tag 建 Release，把 `CHANGELOG.md` 对应段落贴进去即可。
如果 `npm version` 因工作区不干净失败，先提交 CHANGELOG 等改动再重试。

预发布版本：

```bash
npm version 0.5.0-rc.1
npm publish --tag next --access public --registry=https://registry.npmjs.org/
```

验证稳定后再把 `latest` 指过去：

```bash
npm dist-tag add dsh-wdx-relief@0.5.0-rc.1 latest --registry=https://registry.npmjs.org/
```

## 发布后验证

```bash
npm view dsh-wdx-relief dist-tags --json --registry=https://registry.npmjs.org/
npm view dsh-wdx-relief@0.4.0 version dist.tarball --registry=https://registry.npmjs.org/
```

必要时下载 tarball 检查 `package.json`：

```bash
url=$(npm view dsh-wdx-relief@0.4.0 dist.tarball --registry=https://registry.npmjs.org/)
curl -sL "$url" -o /tmp/dsh-wdx-relief.tgz
tar -xOf /tmp/dsh-wdx-relief.tgz package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)))"
```

确认包含 `dsh.bundle.patch`、`dsh.client`、`engines.dsh`、`icon`，以及
README / CHANGELOG / locale / docs。

## Release commit 与 tag

```bash
git status
git add .
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
```

- tag 必须指向包含该版本代码的 commit。
- 是否 `git push origin main --tags` 由用户明确决定；不要默认推送。

## DSH 里安装新版本

**方式一：插件页**

1. 打开 DSH 侧栏 **插件**；
2. **添加插件** → 输入 `dsh-wdx-relief`（或精确版本 `dsh-wdx-relief@0.4.0`）；
3. 安装源选 npm 官方源；
4. 安装完成后点 **立即启用**。

**方式二：Agent / tool**

```text
plugin_manager: action=install_bundle, target=dsh-wdx-relief
```

从 npm 安装的第三方插件会保存精确版本；后续更新在插件详情的「版本」区块检查并更新。
如果当前 DSH 不提供版本区块，就卸载后安装新的精确版本。

**如果你之前用本地目录 `link:` 安装过开发版，或用 tarball 试装过**，插件页会把它视为
已安装，直接安装 npm 包会报 `already-installed`。先在插件页移除 WDX Relief，再按上面的
步骤安装 npm 包；本地开发版可以之后用路径重新装回。

发布失败或发现严重问题时，npm 版本号不能复用：

```bash
npm deprecate dsh-wdx-relief@0.4.0 "请在 0.4.1 修复后使用" --registry=https://registry.npmjs.org/
```

发布满 72 小时后通常不能再 unpublish，只能发新版本并 deprecate 旧版本。

## 注意

- npm 发布只保证能被「添加插件」按包名安装；**不会自动进入官方“发现”目录**。
  想进入官方目录，需要走 DSH 官方的插件收录/审核流程。
- `engines.dsh` 声明当前包兼容的 DSH 版本；DSH 会在安装前检查，不满足会直接拒绝。
- 第一次发布后，npm 版本号不可复用；有问题的版本只能 deprecate，不能覆盖。