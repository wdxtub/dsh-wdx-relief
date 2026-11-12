#!/usr/bin/env bash
# Publish dsh-wdx-relief to the official npm registry with the browser 2FA flow.
#
#   npm run release             # preflight, login if needed, publish, wait for registry
#   npm run release -- --check  # preflight only (no publish)
#
# The script opens the browser when npm needs authentication and waits for the
# user to finish verification. It never prints or asks for an OTP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGISTRY="https://registry.npmjs.org/"
PKG="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=1; fi

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "需要 node"
command -v expect >/dev/null 2>&1 || fail "需要 expect（brew install expect）"

say "发布 ${PKG}@${VERSION}（npm 官方源）"
if [[ $CHECK_ONLY -eq 1 ]]; then say "模式：--check，只做检查，不发布"; fi

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  fail "工作区不干净：先提交或还原，确保 npm 上的内容等于 HEAD"
fi

PUBLISHED="$(npm view "$PKG@$VERSION" version --registry="$REGISTRY" 2>/dev/null || true)"
if [[ "$PUBLISHED" == "$VERSION" ]]; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    warn "${PKG}@${VERSION} 已经发布过；正式发布会中止"
  else
    fail "${PKG}@${VERSION} 已经发布过，版本号不能复用"
  fi
fi

say "运行测试"
npm test

say "检查打包内容"
npm pack --dry-run >/dev/null

say "检查 npm 登录状态"
WHO="$(npm whoami --registry="$REGISTRY" 2>/dev/null || true)"
if [[ -n "$WHO" ]]; then
  say "已登录：$WHO"
else
  say "未登录或 token 过期，启动浏览器登录"
  expect scripts/npm-login.exp || fail "npm 登录失败"
  WHO="$(npm whoami --registry="$REGISTRY" 2>/dev/null || true)"
  [[ -n "$WHO" ]] || fail "npm 登录后 whoami 仍失败"
  say "已登录：$WHO"
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "检查通过；可以运行 npm run release 正式发布"
  exit 0
fi

LOG="$(mktemp -t dsh-wdx-relief-publish.XXXXXX.log)"
export NPM_PKG="$PKG"
export NPM_VERSION="$VERSION"

publish_once() {
  set +e
  expect scripts/publish-npm.exp 2>&1 | tee "$LOG"
  local code=${PIPESTATUS[0]}
  set -e
  return "$code"
}

say "发布（如浏览器弹出验证页，请在浏览器完成验证，脚本会自动继续）"
if ! publish_once; then
  if grep -qE "E401|EOTP|401 Unauthorized|403 Forbidden|E404|/-/v1/done" "$LOG"; then
    warn "发布认证失败，重新登录后自动重试一次"
    expect scripts/npm-login.exp || fail "npm 登录失败；日志：$LOG"
    if ! publish_once; then
      fail "发布仍失败；日志：$LOG"
    fi
  else
    fail "发布失败；日志：$LOG"
  fi
fi
if ! grep -q "PUBLISH_DONE" "$LOG"; then
  fail "没有看到 npm 发布成功的回执；日志：$LOG"
fi

say "等待 registry 同步 ${PKG}@${VERSION}（最多 5 分钟）"
verified=0
for _ in $(seq 1 60); do
  GOT="$(npm view "$PKG@$VERSION" version --registry="$REGISTRY" 2>/dev/null || true)"
  LATEST="$(npm view "$PKG" dist-tags.latest --registry="$REGISTRY" 2>/dev/null || true)"
  if [[ "$GOT" == "$VERSION" && "$LATEST" == "$VERSION" ]]; then
    verified=1
    break
  fi
  printf '.'
  sleep 5
done
printf '\n'

if [[ $verified -eq 1 ]]; then
  TARBALL="$(npm view "$PKG@$VERSION" dist.tarball --registry="$REGISTRY" 2>/dev/null || true)"
  say "发布成功：${PKG}@${VERSION}，latest 已指向该版本"
  [[ -n "$TARBALL" ]] && say "tarball：$TARBALL"
  printf '\n后续（安装验证通过后）：\n  git tag -a v%s -m "v%s"\n' "$VERSION" "$VERSION"
  printf '  需要推送远端时再由你决定：git push origin main --tags\n'
  exit 0
fi

warn "npm 已接受发布，但 registry 暂未同步；不要重复发布，稍后用下面命令检查："
printf '  npm view %s dist-tags version --registry=%s\n' "$PKG" "$REGISTRY"
exit 0