#!/usr/bin/env bash
# =============================================================================
# WebXR 授权服务器 —— 一键部署（Ubuntu / Debian）
#
#   sudo bash deploy/install.sh
#
# 环境变量覆盖（都可选）：
#   DOMAIN=webvr123.site     证书域名（Caddy 用它申请 HTTPS）
#   APP_DIR=/opt/webvr123    安装目录
#   APP_USER=webvr123        运行用的系统用户
#   PORT=8787                本机监听端口（只绑 127.0.0.1，不对外）
#   NODE_MAJOR=22            要装的 Node 大版本
#   FORCE_NODE=1             已有 Node 18~21 时也强行升到 22
#   FORCE_CADDY=1            已有其它站点时，强行覆盖 /etc/caddy/Caddyfile
#   TAKEOVER=1               已有 nginx 等占着 80/443 时，停用它们交给 Caddy
#                            （只停服务；/etc/nginx 与网站文件原样保留）
#   KILL_PORT=1              本机端口（默认 8787）被【别的】进程占用时，结束那个进程
#                            （默认【不杀】—— 只建议换端口：PORT=8788）
#
# 幂等：可反复执行。
#   · 已有签发私钥    → 保留，绝不覆盖
#   · 已有管理员密码  → 保留，绝不覆盖
#   · 已有其它站点配置 → 备份后【不覆盖】，除非 FORCE_CADDY=1
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-webvr123.site}"
APP_DIR="${APP_DIR:-/opt/webvr123}"
APP_USER="${APP_USER:-webvr123}"
PORT="${PORT:-8787}"
NODE_MAJOR="${NODE_MAJOR:-22}"

# 脚本所在目录的上一级 = 代码根目录
SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

C_CYAN='\033[1;36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[1;31m'; C_OFF='\033[0m'
step() { printf "\n${C_CYAN}==> %s${C_OFF}\n" "$*"; }
ok()   { printf "    ${C_GREEN}[ok]${C_OFF} %s\n" "$*"; }
warn() { printf "    ${C_YELLOW}[!] ${C_OFF} %s\n" "$*"; }
die()  { printf "\n${C_RED}[fatal]${C_OFF} %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0/10 前置检查
step "0/10  前置检查"

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：  sudo bash $0"

[ -f /etc/os-release ] || die "无法识别系统（缺 /etc/os-release）。本脚本只支持 Ubuntu / Debian。"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu:*|debian:*|*:*debian*) ok "系统：${PRETTY_NAME:-$ID}" ;;
  *) die "本脚本只支持 Debian 系，当前是 ${PRETTY_NAME:-$ID}。RPM 系需要用另一套（apt→dnf）。" ;;
esac

[ -f "$SRC_DIR/server.js" ] || die "在 $SRC_DIR 找不到 server.js —— 请确认代码已完整上传。"
[ -f "$SRC_DIR/deploy/webvr123.service" ] || die "在 $SRC_DIR/deploy 找不到 webvr123.service。"
ok "代码目录：$SRC_DIR"

# ---------------------------------------------------------------- 1/10 基础依赖
step "1/10  安装基础依赖（curl / gpg / rsync）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync >/dev/null
ok "基础依赖就绪"

# ---------------------------------------------------------------- 2/10 Node.js
step "2/10  检查 Node.js"

node_major() {
  if command -v node >/dev/null 2>&1; then
    node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
  else
    echo 0
  fi
}

install_node() {
  ok "从 NodeSource 安装 Node ${NODE_MAJOR}.x ……"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) 安装完成"
}

MAJ="$(node_major)"
if [ "$MAJ" -ge "$NODE_MAJOR" ]; then
  ok "已有 Node $(node -v)  ≥ ${NODE_MAJOR}（可用内置 node:sqlite）"
elif [ "$MAJ" -ge 18 ]; then
  if [ "${FORCE_NODE:-0}" = "1" ]; then
    install_node
  else
    warn "已有 Node $(node -v) —— 能跑，但存储会降级为 JSON 文件（功能一样，性能略低）"
    warn "想升级：  FORCE_NODE=1 sudo bash $0"
  fi
else
  if [ "$MAJ" -eq 0 ]; then
    ok "未检测到 Node"
  else
    warn "已有 Node $(node -v) 版本过低（< 18），将升级"
  fi
  install_node
fi

# ---------------------------------------------------------------- 3/10 Caddy
step "3/10  检查 Caddy"
if command -v caddy >/dev/null 2>&1; then
  ok "已有 Caddy：$(caddy version 2>/dev/null | head -1)"
else
  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  ok "Caddy 安装完成：$(caddy version 2>/dev/null | head -1)"
fi

# ---------------------------------------------------------------- 4/10 端口与既有服务
step "4/10 端口占用与既有服务检查"

# 找出占用某端口的监听者（尽力而为：ss → netstat → 取不到就留空）
port_owner() {
  local port="$1" line=""
  if command -v ss >/dev/null 2>&1; then
    line="$(ss -ltnp 2>/dev/null | awk -v P=":${port}$" '$4 ~ P {print; exit}' || true)"
  fi
  if [ -z "$line" ] && command -v netstat >/dev/null 2>&1; then
    line="$(netstat -ltnp 2>/dev/null | awk -v P=":${port}$" '$4 ~ P {print; exit}' || true)"
  fi
  printf '%s' "$line"
}

PORT80="$(port_owner 80)"
PORT443="$(port_owner 443)"
PORTAPP="$(port_owner "$PORT")"

[ -n "$PORT80" ]  && warn "80  已被占用：${PORT80}"
[ -n "$PORT443" ] && warn "443 已被占用：${PORT443}"

# --- nginx：最常见的 80/443 占用者 ---
if systemctl is-active --quiet nginx 2>/dev/null; then
  if [ "${TAKEOVER:-0}" = "1" ]; then
    NGINX_ROOT="$(nginx -T 2>/dev/null | awk '/^[[:space:]]*root[[:space:]]/ {print $2; exit}' | tr -d ';' || true)"
    systemctl stop nginx >/dev/null 2>&1 || true
    systemctl disable nginx >/dev/null 2>&1 || true
    ok "已停用并禁用 nginx —— 80 / 443 交给 Caddy"
    ok "  /etc/nginx 与网站文件【原样保留】；要恢复：systemctl enable --now nginx"
    [ -n "$NGINX_ROOT" ] && ok "  原网站目录（未改动）：${NGINX_ROOT}"
  else
    warn "nginx 正在运行，占着 80 / 443 —— Caddy 起不来、证书也申请不到"
    warn "  确认可以停掉后重跑：  TAKEOVER=1 sudo bash $0"
    warn "  （停止只是停服务，/etc/nginx 与网站文件都不会被删）"
  fi
fi

# --- 证书续期定时器：会和 Caddy 抢 80 端口 ---
for T in certbot.timer snap.certbot.renew.timer; do
  if systemctl list-timers --all --no-legend 2>/dev/null | grep -q "$T"; then
    if [ "${TAKEOVER:-0}" = "1" ]; then
      systemctl disable --now "$T" >/dev/null 2>&1 || true
      ok "已停用证书续期定时器 $T（改由 Caddy 自动管理证书）"
    else
      warn "发现证书续期定时器 $T —— 它会和 Caddy 抢 80 端口"
      warn "  停掉：  sudo systemctl disable --now $T"
    fi
  fi
done

# --- 本服务要监听的端口 ---
# 取 pid 用 awk 而不是 sed：sed 的替换串必须写 \1，多层引号下极易被吃掉，
# 一旦变成空串就会「假装杀成功、端口其实没释放」，后面报一个看不懂的绑定错误。
PORT_PID="$(printf '%s' "$PORTAPP" | tr ',()' '\n\n\n' | awk -F= '/^pid=/{print $2; exit}')"

# 光看 systemctl is-active 认不出「以前手动起过、现在游离在外的 node server.js」——
# 那种会被误判成「本服务占用」而跳过告警，最后照样 EADDRINUSE。所以拿 MainPID 比对。
UNIT_MAINPID="$(systemctl show -p MainPID --value webvr123 2>/dev/null || true)"
[ -n "$UNIT_MAINPID" ] || UNIT_MAINPID=0

SELF_OCCUPIED=0
if [ -n "$PORT_PID" ] && [ "$UNIT_MAINPID" != "0" ] && [ "$PORT_PID" = "$UNIT_MAINPID" ]; then
  SELF_OCCUPIED=1
elif [ -z "$PORT_PID" ] && systemctl is-active --quiet webvr123 2>/dev/null; then
  SELF_OCCUPIED=1    # 拿不到 pid 但本服务在跑 → 保守当成自己的，别误报
fi

if [ -z "$PORTAPP" ]; then
  ok "${PORT} 空闲"
elif [ "$SELF_OCCUPIED" = "1" ]; then
  ok "${PORT} 由上次安装的本服务占用（重启时会自动释放）"
elif [ "${KILL_PORT:-0}" = "1" ]; then
  if [ -n "$PORT_PID" ]; then
    kill "$PORT_PID" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$PORT_PID" >/dev/null 2>&1; then
      warn "进程 ${PORT_PID} 仍在运行（可能无权结束）—— 别信「已结束」，按端口再确认一次"
      warn "  改用其它端口重跑：  PORT=8788 sudo bash $0"
    else
      ok "已结束占用 ${PORT} 的进程（pid=${PORT_PID}）"
    fi
  else
    warn "${PORT} 被占用，但拿不到 pid"
    warn "  改用其它端口重跑：  PORT=8788 sudo bash $0"
  fi
else
  # 故意【不】自动结束占用者：它可能是别人的东西，也可能是用户自己另一项业务；
  # 而 8787 只是个内部端口 —— 换端口零代价，杀进程有代价。破坏性动作必须显式授权。
  #
  # 并且【立刻停下】，不要往后跑：第 7 步会把这个端口写进 systemd 单元，第 10 步服务必然
  # EADDRINUSE 起不来 —— 让操作员白等几分钟、最后收到一段看不懂的 Node 栈 + exit-code 报错。
  warn "${PORT} 已被【其它】进程占用：${PORTAPP}"
  warn "继续跑必然在第 10 步以 EADDRINUSE 失败（当前就是在这里停下）"
  warn "照做其一："
  warn "  ① 换端口（零风险，推荐）：  PORT=8788 sudo bash $0"
  warn "  ② 确认那个进程可以结束时：  KILL_PORT=1 sudo bash $0"
  die "端口 ${PORT} 被占用 —— 按上面 ① 或 ② 重跑"
fi

# ---------------------------------------------------------------- 5/10 用户与目录
step "5/10  建立运行用户与安装目录"

if id "$APP_USER" >/dev/null 2>&1; then
  ok "运行用户 $APP_USER 已存在"
else
  useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$APP_USER"
  ok "已创建系统用户 $APP_USER（无登录权限）"
fi

mkdir -p "$APP_DIR"
if [ "$SRC_DIR" = "$APP_DIR" ]; then
  ok "代码已在 $APP_DIR，跳过复制"
else
  rsync -a --delete \
    --exclude 'data/' --exclude 'node_modules/' --exclude '.git/' \
    "$SRC_DIR"/ "$APP_DIR"/
  ok "代码已同步到 $APP_DIR"
fi

# ---------------------------------------------------------------- 6/10 签发密钥
step "6/10  签发密钥（Ks）与管理凭证"

KEY="$APP_DIR/secrets/license-sign.pem"
ADMIN_FILE="$APP_DIR/secrets/admin.json"
mkdir -p "$APP_DIR/secrets" "$APP_DIR/data"

# --- 签发私钥：有就保留，绝不覆盖 ---
if [ -f "$KEY" ]; then
  ok "已存在签发私钥 → 保留不动（绝不覆盖）"
else
  warn "未找到签发私钥 → 在【本机】生成一套新密钥（私钥从此不经手任何其它机器）"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && node gen-keys.js" >/dev/null
  ok "已生成 secrets/license-sign.pem"
fi

# --- 管理员凭证：必须在这里预先生成 ---
# 原因：systemd 单元用 ProtectSystem=strict，/opt/webvr123 对服务是只读的，
# 只放开了 data/。若等首次启动时再自动生成，写 secrets/admin.json 会失败 → 服务起不来。
if [ -f "$ADMIN_FILE" ]; then
  ok "已存在管理员凭证 → 保留不动"
else
  # 随机密码由 node 自己生成并直接落盘，不作为命令行参数传递。
  # 理由：参数会存在于该进程的 argv 里，执行瞬间同机的其它用户可从 `ps` 看到密码。
  # （已实测：Node 的 -e 之后的位置参数不会被当选项解析，所以传参不会报错 —— 是安全问题不是兼容问题。）
  node -e "const fs=require('node:fs'),c=require('node:crypto');fs.writeFileSync(process.argv[1],JSON.stringify({user:'admin',pass:c.randomBytes(12).toString('base64url')},null,2))" \
    "$ADMIN_FILE"
  ok "已生成管理员凭证 secrets/admin.json"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 700 "$APP_DIR/secrets"
chmod 600 "$KEY" "$ADMIN_FILE"
ok "权限已收紧（secrets/ 700，私钥与凭证 600）"

PUB_B64="$(tr -d '\r\n' < "$APP_DIR/secrets/public-key.txt")"
FPR="$(sha256sum "$APP_DIR/secrets/license-pub.pem" | cut -c1-24)"

# ---------------------------------------------------------------- 7/10 systemd
step "7/10  安装 systemd 服务"

NODE_BIN="$(command -v node)"
sed -e "s#^ExecStart=.*#ExecStart=${NODE_BIN} server.js#" \
    -e "s#^Environment=PORT=.*#Environment=PORT=${PORT}#" \
    "$APP_DIR/deploy/webvr123.service" > /etc/systemd/system/webvr123.service
systemctl daemon-reload
systemctl enable webvr123 >/dev/null 2>&1 || true
ok "已安装 /etc/systemd/system/webvr123.service"
ok "  ExecStart=${NODE_BIN} server.js    （已按实际 node 路径改写）"

# ---------------------------------------------------------------- 8/10 Caddy
step "8/10  配置 Caddy（自动 HTTPS）"

write_caddy() {
  sed -e "s#^webvr123\.site {#${DOMAIN} {#" \
      -e "s#127\.0\.0\.1:8787#127.0.0.1:${PORT}#" \
      "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
  ok "已写入 /etc/caddy/Caddyfile（站点：${DOMAIN}）"
}

# Caddy 的发行包会自带一份【占位】Caddyfile。**两个世代都要认**：
#   · 旧版写法：respond "Hello, world!"
#   · 新版写法（2.7+）：:80 { root * /usr/share/caddy → file_server }，欢迎页标题是 "Caddy works!"
# 它们都是货真价实的站点块、但不是用户的东西。若按「已有其它站点」处理就会【跳过写入】，
# 表面一切正常，实际 Caddy 一直在应答自带的欢迎页、HTTPS 永远起不来 —— 且极难看出原因。
# ⚠ 实测踩坑：新版默认**含花括号**，所以「有花括号 = 用户自定义」这类凭语法结构的粗判会把它
#   误判成自定义站点 → 脚本按设计【拒绝覆盖】→ 最后只表现为「HTTPS 暂未通过」，排查方向完全跑偏。
#   正确姿势是【只认已知占位特征】——列出具体的默认路径 / 文案，而不是靠语法结构去猜。
is_stock_caddyfile() {
  local f="$1"
  [ -s "$f" ] || return 0                     # 空文件 = 没有站点，可覆盖
  grep -q 'Hello, world!' "$f" 2>/dev/null && return 0
  grep -q '/usr/share/caddy' "$f" 2>/dev/null && return 0   # 新版 deb 默认站点根目录
  # 通篇只有注释和空行（去掉注释后没有任何非空白字符）→ 没有真实站点。
  # 注意：别用「没有花括号就当占位」这类宽松规则 ——
  # Caddy 允许把站点地址写成光秃秃一行（如 `oldsite.com`），那样会被误判而静默覆盖掉别人的站点。
  if awk '{ sub(/#.*/, "") } $0 ~ /[^[:space:]]/ { real = 1 } END { exit(real ? 0 : 1) }' "$f"; then
    return 1                                  # 有真实内容 → 不是占位，走备份/不覆盖流程
  fi
  return 0
}

if [ -s /etc/caddy/Caddyfile ] && ! grep -q "$DOMAIN" /etc/caddy/Caddyfile \
   && ! is_stock_caddyfile /etc/caddy/Caddyfile; then
  BAK="/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
  cp /etc/caddy/Caddyfile "$BAK"
  if [ "${FORCE_CADDY:-0}" = "1" ]; then
    warn "已备份原配置到 $BAK，按 FORCE_CADDY=1 覆盖"
    write_caddy
  else
    warn "检测到 /etc/caddy/Caddyfile 里已有【其它站点】配置"
    warn "已备份为 $BAK，但【未覆盖】—— 免得打掉你现有的站点"
    warn "请手动把 $APP_DIR/deploy/Caddyfile 的站点块合并进去"
    warn "或确认可覆盖后重跑：  FORCE_CADDY=1 sudo bash $0"
  fi
else
  if [ -s /etc/caddy/Caddyfile ] && is_stock_caddyfile /etc/caddy/Caddyfile; then
    ok "检测到 Caddy 自带的占位配置 → 直接覆盖（那是示例站点，不是你的东西）"
  fi
  write_caddy
fi

# 访问日志目录：Caddyfile 里配了 /var/log/caddy/*.log。
# Caddy 以 caddy 用户运行，建不了目录本身；目录不存在时 Caddy 会【直接启动失败】。
if [ ! -d /var/log/caddy ]; then
  mkdir -p /var/log/caddy
  ok "已创建 /var/log/caddy"
fi
chown caddy:caddy /var/log/caddy 2>/dev/null || true
chmod 755 /var/log/caddy 2>/dev/null || true

# ---------------------------------------------------------------- 9/10 防火墙
step "9/10  放行 80 / 443"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "ufw 已放行 80 / 443"
else
  ok "未启用 ufw —— 若用云安全组，请确认 80 / 443 已放行"
fi
ok "8787 不对外开放（server.js 只绑 127.0.0.1）"

# ---------------------------------------------------------------- 10/10 启动与自测
step "10/10  启动与自测"

systemctl restart webvr123
sleep 2
if systemctl is-active --quiet webvr123; then
  ok "webvr123 服务已运行"
else
  journalctl -u webvr123 -n 30 --no-pager || true
  die "服务启动失败，日志见上"
fi

if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/tmp/_webvr_health.json 2>/dev/null; then
  ok "本机健康检查：$(cat /tmp/_webvr_health.json)"
else
  warn "本机健康检查失败 —— 看日志：journalctl -u webvr123 -n 50 --no-pager"
fi

MYIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
[ -n "$MYIP" ] || MYIP="$(curl -fsS --max-time 5 https://ifconfig.me/ip 2>/dev/null || echo '')"

# 刻意【绕开 /etc/hosts】：机器上常有人为写死的 "IP 域名" 记录，
# getent / ping 会优先读它 → 公网 DNS 明明没解析对，也会报「一致」，
# 把排障方向彻底带偏（真正的判官是 Let's Encrypt，它只看公网 DNS）。
resolve_public() {
  curl -fsS --max-time 6 -H 'accept: application/dns-json' \
    "https://1.1.1.1/dns-query?name=$1&type=A" 2>/dev/null \
    | tr ',' '\n' \
    | awk -F'"' '/"data"[[:space:]]*:/ && $4 ~ /^[0-9]+(\.[0-9]+){3}$/ {print $4; exit}'
}

RESOLVED="$(resolve_public "$DOMAIN" || true)"
RES_SRC="公网 DNS"
if [ -z "$RESOLVED" ]; then
  RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || echo '')"
  RES_SRC="本机解析（含 /etc/hosts，仅供参考）"
fi

if [ -n "$RESOLVED" ] && grep -qiE "(^|[[:space:]])${DOMAIN}([[:space:]]|$)" /etc/hosts 2>/dev/null; then
  warn "/etc/hosts 里有 ${DOMAIN} 的写死记录 —— 本机命令会优先用它，不能当作公网 DNS 结论"
fi

if [ -n "$MYIP" ] && [ -n "$RESOLVED" ]; then
  if [ "$MYIP" = "$RESOLVED" ]; then
    ok "DNS[${RES_SRC}]：${DOMAIN} -> ${RESOLVED}（与本机公网 IP 一致）"
  else
    warn "DNS[${RES_SRC}]不一致：${DOMAIN} -> ${RESOLVED}，但本机公网 IP 是 ${MYIP}"
    warn "         → Caddy 申请不到证书。请在域名商处把 A 记录改到 ${MYIP}"
  fi
fi

systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 3
if curl -fsS --max-time 10 "https://${DOMAIN}/api/health" >/dev/null 2>&1; then
  ok "HTTPS 已就绪"
else
  warn "HTTPS 暂未通过 —— 证书可能还在申请（等 30 秒重试）"
  warn "         仍不通看：journalctl -u caddy -n 50 --no-pager"
fi

# ---------------------------------------------------------------- 总结
ADMIN_LINE="（见 $APP_DIR/secrets/admin.json）"
if [ -f "$APP_DIR/secrets/admin.json" ]; then
  ADMIN_LINE="$(node -e "const j=require('$APP_DIR/secrets/admin.json');process.stdout.write(j.user+' / '+j.pass)" 2>/dev/null || echo "$ADMIN_LINE")"
fi

cat <<EOF

============================================================
  部署完成
------------------------------------------------------------
  健康检查   https://${DOMAIN}/api/health
  管理后台   https://${DOMAIN}/admin
  后台账号   ${ADMIN_LINE}

  公钥指纹   ${FPR}
  公钥内容   ${PUB_B64}
  ^^^ 这两行要抄进 EXE 与 APK 的 LICENSE_PUBKEY_B64 ^^^

  改参数     $APP_DIR/config.json （见 README 第 6 节）
  看日志     journalctl -u webvr123 -f
  重启       systemctl restart webvr123
------------------------------------------------------------
EOF

if [ -z "${PUB_B64:-}" ]; then
  warn "没读到 public-key.txt —— 请检查 $APP_DIR/secrets/"
fi

printf "\n${C_YELLOW}现在必须做的一件事${C_OFF}：把私钥离线备份走\n"
printf "    scp root@本次的IP:${APP_DIR}/secrets/license-sign.pem ./\n"
printf "    （丢了它 = 所有已发 license 都无法续期，只能重发两端的包）\n\n"
