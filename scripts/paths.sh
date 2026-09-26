#!/usr/bin/env bash
# dsh-plugins 共享 bash 路径解析（与 scripts/paths.mjs 同策略，供安装脚本使用）。
#
# 背景：安装脚本需要定位 deepseek-harness（用于 `pnpm dsh plugin ...`）。
# 早期实现把作者本机绝对路径硬编码进脚本，换机器必然失败。
# 本文件**不含任何机器专属路径**。
#
# 用法：
#   source "$(dirname "${BASH_SOURCE[0]}")/paths.sh"
#   HARNESS="$(dsh_resolve_harness)" || exit 1
#
# 解析顺序：
#   1) $DSH_HARNESS_ROOT / $DSH_HARNESS_DIR
#   2) 从调用脚本所在目录（$DSH_PATHS_START，缺省为当前目录）向上逐级
#      查找兄弟目录 deepseek-harness
# 判定标志：目录内存在 vendor/schemastery（harness 检出必有的子路径）。

# 向上查找 deepseek-harness；成功则 echo 绝对路径并返回 0。
dsh_resolve_harness() {
  local d="${1:-${DSH_PATHS_START:-$PWD}}"
  # 归一化起点为绝对路径
  d="$(cd "$d" 2>/dev/null && pwd)" || d="$PWD"
  # 1) 环境变量显式覆盖
  local e
  for e in "$DSH_HARNESS_ROOT" "$DSH_HARNESS_DIR"; do
    if [ -n "$e" ] && [ -d "$e/vendor/schemastery" ]; then
      printf '%s' "$e"; return 0
    fi
  done
  # 2) 向上逐级查找兄弟目录
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ]; do
    if [ -d "$d/deepseek-harness/vendor/schemastery" ]; then
      printf '%s' "$d/deepseek-harness"; return 0
    fi
    local up; up="$(dirname "$d")"
    [ "$up" = "$d" ] && break
    d="$up"
  done
  return 1
}

# 解析失败时的统一报错信息。
dsh_harness_error() {
  echo "错误：找不到 deepseek-harness。" >&2
  echo "  请设置 DSH_HARNESS_ROOT 指向其检出目录，或把 dsh-plugins 与 deepseek-harness 放在同一父目录下。" >&2
}
