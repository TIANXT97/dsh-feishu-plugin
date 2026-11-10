#!/usr/bin/env bash
# Fail loudly when an upstream merge silently drops a carried feature.
# Rationale and the full checklist live in docs/FORK.md
# (「上游更新后的携带特性自查」). A three-way merge can pass with zero
# conflicts while a feature that only existed in the patch layer or an old
# build quietly disappears — this script turns that into a hard error.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
check() { # <说明> <文件> <grep 模式>
  # shellcheck disable=SC2086
  if grep -q "$3" "$2" 2>/dev/null; then
    echo "  ok   $1"
  else
    echo "  MISS $1（$2 缺少 /$3/）" >&2
    fail=1
  fi
}

check "工作区归属（workspaceFor）"       src/dsh/controller.js  "async workspaceFor"
check "工作区注入（workspaceRegistry）"  src/index.js           "workspaceRegistry"
check "卡片序号单点所有（take）"         src/feishu/cardkit.js  "function take(cardId)"
check "序号持久化（touchLiveCard）"      src/state.js           "touchLiveCard"
check "恢复路径 adopt"                   src/dsh/runs.js        "adopt?.(info.cardId"

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'
!! 携带特性被上游合并吞掉了。请对照 docs/FORK.md 的自查清单恢复
   （或从 git 历史找回实现），再重跑本脚本。
EOF
  exit 1
fi
echo "==> 携带特性全部在场"
