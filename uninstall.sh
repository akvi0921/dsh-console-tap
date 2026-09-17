#!/usr/bin/env bash
# ============================================================================
# console-tap 卸载器 —— 与 install.sh 对称:撤组合行 + 删包 + 删软链
# 用法:bash uninstall.sh [--dry-run] [--profile <dir>] [--purge]
#   --purge 连带删除 ~/.dsh/console-logs(每条命令的完整输出留档)
# ============================================================================
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$DSH_HOME_DIR/profiles/web}"
PLUGIN_DIRNAME="console-tap"
LINK_NAME="dsh-console-tap-ui"
PLUGIN_DIR="$PROFILE_DIR/plugins/$PLUGIN_DIRNAME"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
DRY_RUN=0
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --profile) PROFILE_DIR="${2:-}"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done
say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

say "卸载 console-tap"
# 1) 从组合文件里摘掉本插件的两行(连同它们上面的注释块)
if [ -f "$PATCH_FILE" ]; then
  if grep -q 'console-tap' "$PATCH_FILE"; then
    run "cp '$PATCH_FILE' '$PATCH_FILE.bak-$(date +%Y%m%d-%H%M%S)'"
    if [ "$DRY_RUN" = 0 ]; then
      python3 - "$PATCH_FILE" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
# 删掉 "console-tap 注释块 + insert 行" 这一整段
s = re.sub(r"\n*# =+\n# console-tap[\s\S]*?(?=\n# =+|\Z)", "\n", s)
lines, out, skip = s.splitlines(True), [], False
for line in lines:
    if re.match(r"^- insert:\s*$", line):
        out.append(line); skip = False; continue
    if 'console-tap-host' in line or 'console-tap-ui' in line or re.match(r"^\s+name: '@local/dsh-console-tap", line):
        # 丢弃本插件的行,并回滚前一行 "- insert:"
        while out and out[-1].strip() in ('- insert:', ''):
            out.pop()
        skip = True
        continue
    if skip and (line.startswith('    - ') or line.startswith('      ') or line.strip() == ''):
        continue
    skip = False
    out.append(line)
open(p, 'w', encoding='utf-8').write(''.join(out).rstrip('\n') + '\n')
PY
      say "  ✓ 组合行已摘除(原文件已备份)"
    fi
  else
    say "  · 组合文件里没有本插件,跳过"
  fi
else
  say "  · 没有 $PATCH_FILE,跳过"
fi

# 2) 删软链
for d in "$DSH_HOME_DIR/profiles/node_modules/@local" "$PROFILE_DIR/node_modules/@local" "$DSH_HOME_DIR/node_modules/@local"; do
  [ -L "$d/$LINK_NAME" ] && run "rm -f '$d/$LINK_NAME'" || true
done
dsh_pkg="$(grep -oE '/[^ "'\''"]*/@deepseek-ai/dsh' "$(readlink -f "$(command -v dsh 2>/dev/null)" 2>/dev/null)" 2>/dev/null | head -1)"
if [ -n "$dsh_pkg" ] && [ -L "$dsh_pkg/node_modules/@local/$LINK_NAME" ]; then
  run "rm -f '$dsh_pkg/node_modules/@local/$LINK_NAME'"
fi
say "  ✓ 软链已清理"

# 3) 删包
[ -d "$PLUGIN_DIR" ] && run "rm -rf '$PLUGIN_DIR'" && say "  ✓ 插件目录已删除" || say "  · 插件目录不存在"
[ -d "$PLUGIN_DIR.bak" ] && run "rm -rf '$PLUGIN_DIR.bak'" || true

# 4) 可选:删输出留档
if [ "$PURGE" = 1 ]; then
  run "rm -rf '$DSH_HOME_DIR/console-logs'"
  say "  ✓ ~/.dsh/console-logs 已清空"
fi

say ""
say "完成。刷新页面确认右下角「控制台」消失;若组合已热更新,无需重启。"
