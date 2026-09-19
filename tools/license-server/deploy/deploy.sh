#!/usr/bin/env bash
# ============================================================
# 本地部署驱动脚本（在你的开发机上运行，非服务器）
# 步骤：① 填下方变量 ② bash tools/license-server/deploy/deploy.sh
# 它会：重新生成内容 -> scp 授权服务+静态资源到服务器 -> 远程跑 setup-server.sh
# ============================================================
set -euo pipefail

# ===================== 需要你填写 =====================
SERVER_IP="103.117.138.250"      # 香港节点（境外，免备案）。改这里即可切到 HK 服务器
SSH_USER="root"                  # 服务器默认 root
DOMAIN="webvr123.site"           # 你的域名（解析到 HK IP 即免备案）。填了走 Let's Encrypt 受信任证书；留空=自签CA(需装到PICO)
BUILD_DIST=1                     # 置 1 则本地先跑 build-obfuscate 产出 dist/ 再上传（需先把 SERVER_URL 改成对应地址）
# =======================================================

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"   # 项目根
LS_DIR="$REPO/tools/license-server"
DEPLOY_DIR="$LS_DIR/deploy"
DIST_DIR="$REPO/dist"
REMOTE_APP=/opt/license-server

echo "==> [1/5] 本地重新生成 game-content.json（提取最新 src/content）"
node "$LS_DIR/gen-content.mjs"

if [ "$BUILD_DIST" = "1" ]; then
  echo "==> [1b]  构建生产 dist/（SERVER_URL 须已改为 https://$DOMAIN）"
  node "$REPO/tools/build-obfuscate.mjs"
fi

SSH="ssh -o StrictHostKeyChecking=no ${SSH_USER}@${SERVER_IP}"
SCP="scp -o StrictHostKeyChecking=no -r"

echo "==> [2/5] 上传授权服务目录（含 keys/ 私钥与 game-content.json）到 $REMOTE_APP"
$SCP "$LS_DIR" "${SSH_USER}@${SERVER_IP}:/opt/license-server.tmp"
$SSH "rm -rf $REMOTE_APP && mv /opt/license-server.tmp $REMOTE_APP"

if [ -d "$DIST_DIR" ]; then
  echo "==> [3/5] 上传 dist/ 静态资源到 /opt/dist"
  $SCP "$DIST_DIR" "${SSH_USER}@${SERVER_IP}:/opt/dist.tmp"
  $SSH "rm -rf /opt/dist && mv /opt/dist.tmp /opt/dist"
else
  echo "==> [3/5] 跳过 dist/（本地未构建；如需上传，BUILD_DIST=1 或手动 scp）"
fi

echo "==> [4/5] 远程执行初始化（装 Node/Nginx/证书/systemd）"
$SSH "bash $REMOTE_APP/deploy/setup-server.sh $DOMAIN"

echo "==> [5/5] 完成。下一步："
if [ -n "$DOMAIN" ]; then
  echo "   - 确认域名 $DOMAIN 已 A 解析到 $SERVER_IP 且完成 ICP 备案（否则 PICO 浏览器不认证书）"
  echo "   - 本地把 src/core/license.js 的 SERVER_URL 改为 https://$DOMAIN，BUILD_DIST=1 重跑本脚本上传"
  echo "   - 浏览器打开 https://$DOMAIN/ 自测激活+进关；再到 PICO 实测拉配置"
else
  echo "   - 无域名模式：把根 CA 安装到 PICO（见 setup-server.sh 输出），客户端 SERVER_URL 改为 https://$SERVER_IP"
  echo "   - 本地改 src/core/license.js 的 SERVER_URL=https://$SERVER_IP，BUILD_DIST=1 重跑本脚本上传 dist"
  echo "   - 头显浏览器打开 https://$SERVER_IP/ 自测（需先装 CA；桌面 Chrome 也要导入 ca.crt）"
fi
