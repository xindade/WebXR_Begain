#!/bin/sh
# webvr123 授权服务器 · 一键更新（在服务器上执行）
#
# 用法：把本更新包整个目录上传到服务器后，cd 进去执行
#   sh apply-update.sh
# 可选覆盖：APP=/opt/webvr123 SVC=webvr123 VER=1.0.0 sh apply-update.sh
set -eu

APP="${APP:-/opt/webvr123}"
SVC="${SVC:-webvr123}"
VER="${VER:-1.0.0}"

echo "== 目标：APP=$APP SVC=$SVC 内容版本=$VER"
if [ ! -f server.js ]; then echo "!! 当前目录没有 server.js —— 请在本更新包目录里执行"; exit 1; fi
if [ ! -d content ]; then echo "!! 当前目录没有 content/"; exit 1; fi
if [ ! -d "$APP" ]; then echo "!! 目标目录不存在：$APP"; exit 1; fi

TS=$(date +%Y%m%d-%H%M%S)

echo "== ① 备份旧 server.js → server.js.bak-$TS"
cp -p "$APP/server.js" "$APP/server.js.bak-$TS"

echo "== ② 安装新 server.js"
cp -p server.js "$APP/server.js"

echo "== ③ 安装 content/（整目录替换，旧目录留成 content.old-$TS）"
if [ -d "$APP/content" ]; then mv "$APP/content" "$APP/content.old-$TS"; fi
cp -r content "$APP/content"

# 服务用户 webvr123 必须读得到（ProtectSystem=strict 下 /opt/webvr123 对服务只读）
chown -R webvr123:webvr123 "$APP/content" "$APP/server.js" 2>/dev/null || true
chmod -R a+rX "$APP/content"
chmod 644 "$APP/server.js"

echo "== ④ 重启服务"
systemctl restart "$SVC"
sleep 2
echo -n "   systemctl is-active → "; systemctl is-active "$SVC"

echo "== ⑤ 验收 /api/health（应出现 content 字段）"
curl -s --max-time 8 http://127.0.0.1:8787/api/health; echo
echo "== ⑥ 验收 /api/manifest"
curl -s --max-time 8 "http://127.0.0.1:8787/api/manifest?key=webvr-manifest&ver=$VER" | head -c 320; echo

echo ""
echo "== 完成。若要回滚："
echo "   cp -p $APP/server.js.bak-$TS $APP/server.js && systemctl restart $SVC"
