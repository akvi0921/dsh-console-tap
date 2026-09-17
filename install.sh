#!/usr/bin/env bash
# ============================================================================
# console-tap 一键安装器 —— 把「控制台显形」插件装进本机 DSH 的 web profile
# ----------------------------------------------------------------------------
# 做四件事(全部幂等,可反复执行):
#   ① 取回插件包(优先 git clone,失败则 curl 走镜像下载 tarball)
#   ② 落到 <profile>/plugins/console-tap/,建 4 处 node_modules 软链
#   ③ 往 <profile>/cordis.patch.yml 追加两条组合行(已存在则跳过;改前自动备份)
#   ④ 自检:文件/软链/组合行/诊断端点(服务在跑时直接探测 /api/console/status)
#
# 用法:
#   bash install.sh                     # 默认装到 ~/.dsh/profiles/web
#   bash install.sh --dry-run           # 只打印要做什么,不落任何改动
#   bash install.sh --source <dir>      # 用本地目录作为源(离线/自测)
#   bash install.sh --profile <dir>     # 指定 profile 目录
#   bash install.sh --port 3080         # 自检探测的端口
# 环境变量:DSH_HOME / DSH_PROFILE_DIR / CT_MIRROR
# ============================================================================
set -euo pipefail

REPO_SLUG="akvi0921/dsh-console-tap"
BRANCH="main"
PKG_NAME="@local/dsh-console-tap-ui"
PLUGIN_DIRNAME="console-tap"          # 目录名(组合行里的相对路径依赖它)
LINK_NAME="dsh-console-tap-ui"        # @local/ 下的软链名(必须等于包名,裸包名才能解析)

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$DSH_HOME_DIR/profiles/web}"
PORT="3080"
DRY_RUN=0
SOURCE_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --profile) PROFILE_DIR="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

PLUGIN_DIR="$PROFILE_DIR/plugins/$PLUGIN_DIRNAME"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
TMP_DIR="$(mktemp -d "${TMPDIR:-$HOME/tmp}/ct-install-XXXXXX" 2>/dev/null || mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ---------------------------------------------------------------- 镜像 / 下载
mirror_list() {
  if [ -n "${CT_MIRROR:-}" ]; then printf '%s\n' "$CT_MIRROR"; fi
  # 直连优先,再走常用加速镜像(国内网络下更稳)
  printf '%s\n' "https://github.com"
  printf '%s\n' "https://ghfast.top/https://github.com"
  printf '%s\n' "https://gh-proxy.com/https://github.com"
  printf '%s\n' "https://ghproxy.net/https://github.com"
}

fetch_sources() {
  local dest="$1"
  if [ -n "$SOURCE_DIR" ]; then
    [ -f "$SOURCE_DIR/lib/host.js" ] || die "源目录里没有 lib/host.js:$SOURCE_DIR"
    mkdir -p "$dest"; cp -r "$SOURCE_DIR/." "$dest/"
    ok "使用本地源:$SOURCE_DIR"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] 将尝试从以下镜像取回 $REPO_SLUG"
    mirror_list | sed 's/^/    - /'
    return 0
  fi
  while IFS= read -r base; do
    [ -n "$base" ] || continue
    local url="$base/$REPO_SLUG.git"
    if git clone --depth 1 --branch "$BRANCH" "$url" "$dest" >/dev/null 2>&1; then
      ok "git clone 成功($base)"; return 0
    fi
    rm -rf "$dest"
    # tarball 兜底
    local tarurl="$base/$REPO_SLUG/archive/refs/heads/$BRANCH.tar.gz"
    if curl -fsSL --connect-timeout 8 -m 120 "$tarurl" -o "$TMP_DIR/src.tar.gz" 2>/dev/null; then
      mkdir -p "$dest"
      tar -xzf "$TMP_DIR/src.tar.gz" -C "$dest" --strip-components=1 >/dev/null 2>&1 && { ok "tarball 下载成功($base)"; return 0; }
      rm -rf "$dest"
    fi
    warn "该镜像失败:$base"
  done < <(mirror_list)
  die "所有镜像都失败;可用 --source <本地目录> 离线安装,或设置 CT_MIRROR"
}

# ---------------------------------------------------------------- 找 dsh 安装目录(第 4 个软链锚点在这)
resolve_dsh_node_modules() {
  local bin real pkg
  bin="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$bin" ]; then
    real="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
    # 情况 A:包装脚本里写死了 …/@deepseek-ai/dsh/lib/bin.js(Termux 的 dsh 就是这样)
    pkg="$(grep -oE '/[^ "'\''"]*/@deepseek-ai/dsh' "$real" 2>/dev/null | head -1)"
    # 情况 B:dsh 本身就是软链/真实文件落在 …/@deepseek-ai/dsh/lib/bin.js
    if [ -z "$pkg" ]; then
      case "$real" in */@deepseek-ai/dsh/lib/bin.js) pkg="${real%/lib/bin.js}" ;; esac
    fi
    if [ -n "$pkg" ] && [ -d "$pkg/node_modules" ]; then printf '%s' "$pkg/node_modules"; return 0; fi
  fi
  for cand in \
    "${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai/dsh/node_modules" \
    "$HOME/usr/lib/node_modules/@deepseek-ai/dsh/node_modules" \
    "$(npm root -g 2>/dev/null || true)/@deepseek-ai/dsh/node_modules"; do
    [ -n "$cand" ] && [ -d "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

say "console-tap 安装器"
say "  DSH_HOME   : $DSH_HOME_DIR"
say "  profile    : $PROFILE_DIR"
say "  插件目录   : $PLUGIN_DIR"
say "  组合文件   : $PATCH_FILE"
say ""

# 0) 前置检查
[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录:$PROFILE_DIR(用 --profile 指定,或先跑一次 dsh web)"
[ -f "$PATCH_FILE" ] || [ -f "$PROFILE_DIR/cordis.yml" ] || warn "profile 里既没有 cordis.yml 也没有 cordis.patch.yml,确认目录是否正确"
say "1) 取回插件包"
fetch_sources "$TMP_DIR/src"
[ "$DRY_RUN" = 1 ] || [ -f "$TMP_DIR/src/lib/host.js" ] || die "取回的内容里没有 lib/host.js"

# 1) 落包(先备份旧包)
say "2) 安装插件文件"
if [ -d "$PLUGIN_DIR" ]; then
  run "rm -rf '$PLUGIN_DIR.bak'"
  run "cp -r '$PLUGIN_DIR' '$PLUGIN_DIR.bak'"
  ok "旧版本已备份到 $PLUGIN_DIR.bak"
fi
run "mkdir -p '$PLUGIN_DIR/lib'"
if [ "$DRY_RUN" = 1 ]; then
  say "  [dry-run] cp package.json lib/host.js lib/client.js → $PLUGIN_DIR"
else
  cp "$TMP_DIR/src/package.json" "$PLUGIN_DIR/package.json"
  cp "$TMP_DIR/src/lib/host.js"   "$PLUGIN_DIR/lib/host.js"
  cp "$TMP_DIR/src/lib/client.js" "$PLUGIN_DIR/lib/client.js"
  [ -d "$TMP_DIR/src/docs" ] && cp -r "$TMP_DIR/src/docs" "$PLUGIN_DIR/docs"
  ok "package.json / lib/host.js / lib/client.js 就位"
fi

# 2) 软链:四处锚点(宿主 import 与浏览器端包扫描用的解析基准不同)
say "3) 建 node_modules 软链"
link_anchors() {
  local dsh_nm=""
  dsh_nm="$(resolve_dsh_node_modules || true)"
  for d in \
    "$DSH_HOME_DIR/profiles/node_modules/@local" \
    "$PROFILE_DIR/node_modules/@local" \
    "$DSH_HOME_DIR/node_modules/@local" ; do
    run "mkdir -p '$d' && ln -sfn '$PLUGIN_DIR' '$d/$LINK_NAME'"
    ok "$d/$LINK_NAME"
  done
  if [ -n "$dsh_nm" ] && [ -d "$dsh_nm" ]; then
    if [ -w "$dsh_nm" ] || [ "$DRY_RUN" = 1 ]; then
      run "mkdir -p '$dsh_nm/@local' && ln -sfn '$PLUGIN_DIR' '$dsh_nm/@local/$LINK_NAME'"
      ok "$dsh_nm/@local/$LINK_NAME"
    else
      warn "$dsh_nm 不可写,跳过(宿主半个仍可用;浏览器半个若解析失败见 README 的排错)"
    fi
  else
    warn "没找到 dsh 安装目录,跳过第 4 处软链(一般无碍)"
  fi
}
link_anchors

# 3) 组合行
say "4) 写入组合行"
ROW_BLOCK=$(cat <<'YAML'

# ============================================================================
# console-tap —— 控制台显形:采集"助手执行的命令 + 它的完整控制台输出",实时推给前端
# 两条行缺一不可(原因见本插件 docs/DEVELOPMENT.md):
#   ① 宿主半个必须用**相对文件路径**:补丁层热插入的行一定会被 import
#   ② 浏览器半个必须用**裸包名**:官方 dsh-client-modules 只按包元数据发布 bundle
# ============================================================================
- insert:
    - id: console-tap-host
      name: './plugins/console-tap/lib/host.js'
      config:
        pollMs: 150
        fileLogBytes: 67108864
        trace: false
    - id: console-tap-ui
      name: '@local/dsh-console-tap-ui'
YAML
)
if [ -f "$PATCH_FILE" ] && grep -q 'console-tap-host' "$PATCH_FILE" 2>/dev/null; then
  ok "组合行已存在,跳过(如要改配置请直接编辑 $PATCH_FILE)"
else
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] 备份 $PATCH_FILE 并追加两条 insert 行"
  else
    [ -f "$PATCH_FILE" ] && cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%Y%m%d-%H%M%S)"
    printf '%s\n' "$ROW_BLOCK" >> "$PATCH_FILE"
    ok "已追加(备份:$(basename "$PATCH_FILE").bak-*)"
  fi
fi

# 4) 自检
say "5) 自检"
if [ "$DRY_RUN" = 1 ]; then
  say "  [dry-run] 检查文件/软链/组合行 + 探测 http://127.0.0.1:$PORT/api/console/status"
else
  [ -f "$PLUGIN_DIR/lib/host.js" ] && ok "lib/host.js" || die "lib/host.js 缺失"
  [ -f "$PLUGIN_DIR/lib/client.js" ] && ok "lib/client.js" || die "lib/client.js 缺失"
  [ -L "$PROFILE_DIR/node_modules/@local/$LINK_NAME" ] && ok "软链(profile)" || warn "profile 软链不在位"
  grep -q 'console-tap-ui' "$PATCH_FILE" && ok "组合行(两条)" || warn "组合行不完整"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 6 "http://127.0.0.1:$PORT/api/console/status" 2>/dev/null || echo 000)"
  case "$code" in
    200) ok "诊断端点 200 —— 插件已在运行(刷新页面即可看到右下角「控制台」)" ;;
    404) warn "诊断端点 404 —— 服务在跑但插件尚未挂载:改一下 $PATCH_FILE(触发热更新)或重启 dsh web" ;;
    000) warn "探测不到 $PORT 上的 DSH Web 服务(服务没起?端口不是 $PORT?用 --port 指定)" ;;
    *)   warn "诊断端点返回 $code" ;;
  esac
fi

say ""
say "完成。"
say "  ① 打开 DSH Web UI 并**刷新页面** → 右下角出现悬浮「控制台」"
say "  ② 想看某条命令的完整输出文件:~/.dsh/console-logs/<时间>-<id>.log"
say "  ③ 排查用:curl -s http://127.0.0.1:$PORT/api/console/status | head -40"
say "  ④ 卸载:bash uninstall.sh"
