#!/usr/bin/env bash
# =============================================================================
# 签发私钥（Ks）离线备份 —— 一条命令：从服务器拷下来 + 当场演练验证
#
#   bash tools/cast-server/deploy/backup-license-key.sh <目标目录>
#
# 例（Git Bash；插上 U 盘后它常是 /e 或 /f）：
#   bash tools/cast-server/deploy/backup-license-key.sh /e/webvr123-backup
#   bash tools/cast-server/deploy/backup-license-key.sh /f/
#
# Windows 风格路径同样认（脚本会自动转成 /e/...）：
#   bash tools/cast-server/deploy/backup-license-key.sh 'E:\webvr123-backup'
#
# ⚠ 本脚本是 **bash 脚本**，必须在 Git Bash 里跑，**不能**直接在 PowerShell / cmd 里敲：
#     · PowerShell 里的 `cd /e/AI_Work/...` 不是有效路径（应是 E:\AI_Work\...）；
#     · PowerShell 的 PATH 里通常**没有** bash（Git 只把 git.exe 加进 PATH）。
#   要么打开「Git Bash」窗口再跑，要么用同目录下的 backup-license-key.cmd（Windows 启动器）。
#
# 做三件事：
#   ① scp 把 /opt/webvr123/secrets/license-sign.pem 拷到目标目录（会问你服务器 root 密码）；
#   ② 把本地副本权限收紧到 600；
#   ③ **演练**：用它签一份样本 license，再用两端源码里硬编码的公钥验一遍
#      （deploy/backup-drill.js）—— 验过才算备份成功。
#
# ⚠ 目标目录【绝不能】是：
#   · 这个 git 仓库里的任何位置（私钥永不进版本库）；
#   · OneDrive / Dropbox / 坚果云 / Google Drive 之类的同步目录（等于私钥上了云）。
#   · 理想目标是**物理离线介质**：U 盘 / 移动硬盘 / 另一台不联网的机器。
#
# 可覆盖的环境变量：
#   HOST=root@1.2.3.4        服务器地址（默认下面那个）
#   NODE=/path/to/node       指定的 node（默认先查 PATH，再查 C:\Program Files\nodejs\node.exe）
#   SCP=/path/to/scp         指定的 scp（默认先查 PATH，再查 Git/Windows 自带 OpenSSH）
# =============================================================================
set -euo pipefail

# ---- 先把 Git Bash 自带的 coreutils 挂回 PATH（本脚本第一件要做的事）----
# 现场教训（PowerShell 实测）：`bash.exe script.sh` 是**非 login shell**，不读 /etc/profile，
# 从 PowerShell / cmd 直接拉起时 PATH 里**没有 /usr/bin** —— dirname / tr / wc / mkdir / chmod /
# cygpath / scp 会集体 command not found，脚本跑到一半崩，看着像脚本写错了。
case ":$PATH:" in
  *:/usr/bin:*) : ;;                                  # 已经在，不动
  *) PATH="/usr/bin:/bin:$PATH"; export PATH ;;
esac

HOST="${HOST:-root@103.117.138.250}"
KEY_REMOTE="/opt/webvr123/secrets/license-sign.pem"
DEST="${1:-}"
NODE="${NODE:-}"
SCP="${SCP:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CS_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$CS_ROOT/../.." && pwd)"

C_CYAN='\033[1;36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[1;31m'; C_OFF='\033[0m'
step() { printf "\n${C_CYAN}==> %s${C_OFF}\n" "$*"; }
ok()   { printf "    ${C_GREEN}[ok]${C_OFF} %s\n" "$*"; }
warn() { printf "    ${C_YELLOW}[!] ${C_OFF} %s\n" "$*"; }
die()  { printf "\n${C_RED}[fatal]${C_OFF} %s\n" "$*" >&2; exit 2; }

[ -n "$DEST" ] || die "缺目标目录。用法： bash $0 <目标目录>   （例：bash $0 /e/webvr123-backup 或 E:\\webvr123-backup）"

# ---- 允许 Windows 风格路径：E:\foo、E:/foo、e:/foo 一律归一化成 /e/foo ----
# 现场教训：从 PowerShell / cmd 调本脚本时，最自然的写法就是 E:\xxx；
# 而 bash 的 dirname 会把 "E:\xxx" 拆成 "E:"，于是报「目标目录的上级不存在」——
# 看着像脚本坏了，其实只是路径写法不对。这里统一兜住。
case "$DEST" in
  [A-Za-z]:[\\/]*)
    _drv="$(printf '%s' "${DEST:0:1}" | tr 'A-Z' 'a-z')"
    _rest="${DEST:2}"; _rest="${_rest//\\//}"
    DEST="/${_drv}/${_rest}"
    ;;
esac

# ---- 工具探测：PATH 里没有就去常见安装位置找 ----
# （现场教训：在「不是 Git Bash」的 shell 里跑，以及 PATH 很薄的环境里跑，都会导致
#   「命令找不到」而不是「脚本报错」，很容易被误读成脚本坏了。这里统一兜住。）
find_tool() {                       # find_tool <变量名> <命令名> [候选绝对路径...]
  local var="$1" name="$2"; shift 2
  local hit
  hit="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$hit" ]; then
    for c in "$@"; do [ -x "$c" ] && { hit="$c"; break; }; done
  fi
  [ -n "$hit" ] && eval "$var=\"\$hit\""
  [ -n "$hit" ]
}
WIN_BIN="/c/Program Files/Git/usr/bin"          # Git for Windows 自带的 OpenSSH

# ---- 本机 POSIX 路径 → Windows 路径（只在交给**原生 Windows 程序**时用）----
# 现场教训（实测）：Git Bash 会把 POSIX 路径**按启发式**转成 Windows 路径再交给原生程序，
# 而这条启发式会被环境变量左右 —— 一旦 `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL=*` 存在
# （大量 IDE / 沙箱 / CI 的 shell 包装器都会带上，且会**继承进子进程**），转换就被关掉，
# node.exe 于是把 `/e/AI_Work/x.js` 理解成「E 盘根下的 \e\AI_Work\x.js」⇒ 报 MODULE_NOT_FOUND，
# 看着像脚本路径写错了。
# `cygpath -w` 是**确定性**转换，不受这些环境变量影响 ⇒ 一律先过它。
to_win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w -- "$1"; else printf '%s' "$1"; fi; }
# MSYS/Cygwin 自带的那批程序（Git Bash 的 /usr/bin/*）本来就吃 POSIX 路径，不必转
is_msys_bin() { case "$1" in /usr/*|/bin/*) return 0 ;; *) return 1 ;; esac; }
if [ -z "$SCP" ]; then
  find_tool SCP scp \
    "$WIN_BIN/scp" \
    "/c/Windows/System32/OpenSSH/scp.exe" \
    "$(command -v cygpath >/dev/null 2>&1 && cygpath -u "$SYSTEMROOT/System32/OpenSSH/scp.exe" || echo /c/Windows/System32/OpenSSH/scp.exe)" \
    || die "找不到 scp —— 请在【Git Bash】里跑本脚本（它自带 OpenSSH；Windows 10+ 也自带 System32/OpenSSH）"
fi
if [ -z "$NODE" ]; then
  find_tool NODE node \
    "/c/Program Files/nodejs/node.exe" \
    || die "找不到 node —— 装 Node.js，或用 NODE=/路径/node 指定"
fi
[ -n "$HOST" ] || die "HOST 为空"

# ---- 目标目录安全检查 ----
DEST_PARENT="$(dirname -- "$DEST")"
DEST_ABS="$(cd -- "$DEST_PARENT" 2>/dev/null && pwd)/$(basename -- "$DEST")" \
  || die "目标目录的上级不存在：$DEST_PARENT　（Windows 风格路径脚本会自动转换；仍报此错说明上级目录还没建：先 mkdir -p \"$DEST_PARENT\"）"
case "$DEST_ABS" in
  "$REPO_ROOT"/*) die "目标目录在 git 仓库里（$REPO_ROOT）—— 私钥绝不能进版本库，请换一个位置" ;;
esac
case "$DEST_ABS" in
  *[Oo]ne[Dd]rive*|*[Dd]ropbox*|*[Nn]utstore*|*坚果云*|*[Gg]oogle*[Dd]rive*|*百度网盘*)
    die "目标目录看着是【云同步目录】—— 那等于把私钥传到云上。请改用 U 盘 / 离线硬盘" ;;
esac

# scp 的目标路径：Git Bash 自带的 /usr/bin/scp 吃 POSIX 路径，保持原样；
# 若探测到的是 Windows 原生 scp.exe，则必须转成 Windows 路径。
SCP_DEST="$DEST_ABS/license-sign.pem"
is_msys_bin "$SCP" || SCP_DEST="$(to_win "$SCP_DEST")"

step "0/4  目标：$DEST_ABS"
ok "scp  = $SCP"
ok "node = $NODE  ($("$NODE" -v 2>&1 | tr -d '\r'))"
mkdir -p "$DEST_ABS"
chmod 700 "$DEST_ABS" 2>/dev/null || true
ok "目录已就绪"

step "1/4  从服务器拷私钥（会提示输入 root 密码）"
ok "来源：${HOST}:${KEY_REMOTE}"
ok "落点：$SCP_DEST"
# 优先 SFTP 协议；少数服务器没开 sftp 子系统，回退到传统 scp 协议（-O）
# -o ConnectTimeout=15：网络不通时 15 秒内失败，而不是无限等
if ! "$SCP" -o ConnectTimeout=15 -p "$HOST:$KEY_REMOTE" "$SCP_DEST"; then
  warn "常规方式失败，回退传统协议重试（-O）……"
  "$SCP" -o ConnectTimeout=15 -O -p "$HOST:$KEY_REMOTE" "$SCP_DEST" \
    || die "拷贝失败 —— 检查网络 / 密码 / 服务器上是否有 $KEY_REMOTE"
fi
chmod 600 "$DEST_ABS/license-sign.pem" 2>/dev/null || true
ok "已拷到 $DEST_ABS/license-sign.pem"

step "2/4  文件大小检查"
SIZE="$(wc -c < "$DEST_ABS/license-sign.pem" | tr -d ' ')"
if [ "$SIZE" -lt 200 ] || [ "$SIZE" -gt 2000 ]; then
  warn "大小 ${SIZE} 字节，不像一把 PKCS#8 P-256 私钥（正常 ~241 字节）—— 下面演练会给出结论"
else
  ok "${SIZE} 字节（正常量级）"
fi

step "3/4  演练：这份备份到底能不能用（关键一步）"
set +e
"$NODE" "$(to_win "$SCRIPT_DIR/backup-drill.js")" "$(to_win "$DEST_ABS/license-sign.pem")"
DRILL_RC=$?
set -e

if [ "$DRILL_RC" -ne 0 ]; then
  printf "\n${C_RED}演练未通过 —— 这份文件【不能】当备份。${C_OFF}\n"
  printf "  · 服务器上的原件${C_YELLOW}千万别删${C_OFF}，重新拷一次；\n"
  printf "  · 若反复失败，先在服务器上确认： ls -l %s\n" "$KEY_REMOTE"
  exit 1
fi

step "4/4  备份完成 —— 收尾清单"
cat <<EOF

  ${C_GREEN}[1]${C_OFF} 再拷第二份到【另一个物理位置】（单份不算备份）：
        · 另一支 U 盘放进保险柜 / 另一个不联网的地方；
        · 或打印上面那行【公钥指纹】贴在设备上，日后核对方便。
  ${C_GREEN}[2]${C_OFF} 要不要删除本机这份临时副本？
        · 本机是联网的开发机 —— 最稳的做法是：转存到离线介质后，把这份删掉。
        · 目标目录若本来就是 U 盘，则已经达成目的，无需再动。
  ${C_GREEN}[3]${C_OFF} 顺带记下管理员后台账号（另一件事，别和私钥放一起）：
        ssh ${HOST} 'cat /opt/webvr123/secrets/admin.json'

EOF
