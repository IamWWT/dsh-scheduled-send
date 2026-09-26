#!/usr/bin/env bash
# dsh-scheduled-send 一键开发期安装（link 方式 + 安装后验证）。
#
# 用法：bash scripts/install-to-dsh.sh [DSH_HOME] [HARNESS_DIR]
#   DSH_HOME    缺省 $HOME/.dsh-dev
#   HARNESS_DIR 缺省自动解析（env DSH_HARNESS_ROOT → 向上找兄弟 deepseek-harness）
#
# 流程：构建(产物门禁) → 冒烟测试 → 移除旧安装 → link 安装 → 安装后验证。
# 任何一步失败即退出；**不会自动重启 dsh**——最后打印需要你确认的重启命令。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=./paths.sh
source "$HERE/paths.sh"
DSH_HOME_ARG="${1:-$HOME/.dsh-dev}"
HARNESS_DIR="${2:-${DSH_HARNESS_ROOT:-${DSH_HARNESS_DIR:-$(dsh_resolve_harness "$PLUGIN_DIR")}}}"
[ -n "$HARNESS_DIR" ] && [ -d "$HARNESS_DIR" ] || { dsh_harness_error; exit 1; }
PROFILE="web"
INSTALLED="$DSH_HOME_ARG/profiles/$PROFILE/node_modules/dsh-scheduled-send"

echo "==> 1/5 构建 + 产物门禁（缺 lib/ 等坏布局会在装进 profile 前被拦下）"
(cd "$PLUGIN_DIR" && node scripts/build.mjs)

echo "==> 2/5 冒烟测试"
(cd "$PLUGIN_DIR" && node test/smoke-test.mjs)

echo "==> 3/5 移除旧安装（避免 pnpm file:tgz 缓存 / 旧布局残留）"
(cd "$HARNESS_DIR" && DSH_HOME="$DSH_HOME_ARG" pnpm dsh plugin --profile "$PROFILE" rm dsh-scheduled-send >/dev/null 2>&1 || true)

echo "==> 4/5 link 安装（源码目录，免去 tgz/store 环节）"
(cd "$HARNESS_DIR" && DSH_HOME="$DSH_HOME_ARG" pnpm dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR")

echo "==> 5/5 安装后验证（坏安装就地拦截，而不是等 systemd 反复崩溃）"
node "$PLUGIN_DIR/scripts/verify-installed.mjs" "$INSTALLED"

echo
echo "✔ 安装完成且已通过安装后验证。"
echo "   下一步（脚本不自动执行，需你确认后运行）："
echo "   systemctl --user restart dsh-dev-web"