#!/usr/bin/env bash
# ============================================================
# 服务器端一次性初始化脚本（在 Ubuntu 22.04 轻量服务器上运行）
# 用法：
#   bash setup-server.sh <域名>     # 有域名 -> Let's Encrypt 免费证书（HTTP-01 校验）
#   bash setup-server.sh            # 无域名 -> 自建根 CA + 按 IP 签发证书
# 前置：deploy.sh 已把 license-server/ 与 dist/ 传到 /opt，并把本脚本也传上来了。
# ============================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DOMAIN="${1:-}"
APP_DIR=/opt/license-server
DIST_DIR=/opt/dist
CERT_DIR=/opt/certs
PORT=8787
PRODUCT=webxr-balloon-pcvr
SERVER_IP=103.117.138.250          # 与 deploy.sh 保持一致（香港节点，免备案）

echo "==> [1/6] 安装基础工具与 Node.js 20.x"
apt-get update
apt-get install -y curl ca-certificates
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d v | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [2/6] 准备目录与权限"
mkdir -p "$DIST_DIR" "$CERT_DIR"/acme
chmod 600 "$APP_DIR"/keys/private.pem 2>/dev/null || true

echo "==> [3/6] 安装 Nginx"
apt-get install -y nginx

echo "==> [4/6] 证书与 Nginx 配置"
CONF_SRC="$APP_DIR/deploy/nginx-game.conf"
if [ -n "$DOMAIN" ]; then
  # ---- 有域名：先用 HTTP-only 配置，让 certbot 走 HTTP-01 校验 ----
  echo "    (域名模式) 先写 HTTP-only 配置，再申请 Let's Encrypt"
  cat > /etc/nginx/sites-available/game.conf <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  root $DIST_DIR;
  location / { try_files \$uri \$uri/ /index.html; }
  location /api/ { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host; }
}
EOF
  nginx -t && systemctl reload nginx
  echo "==> [5/6] 申请 Let's Encrypt 证书（webroot 方式，不动 nginx 配置）"
  apt-get install -y certbot
  certbot certonly --webroot -w "$DIST_DIR" -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    || echo "⚠ certbot 失败：确认域名 A 解析到本机($SERVER_IP) 且 80 端口在防火墙放行。"
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  if [ -f "$CERT" ]; then
    sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__CERT__#$CERT#g" -e "s#__KEY__#$KEY#g" -e "s#__PORT__#$PORT#g" \
      "$CONF_SRC" > /etc/nginx/sites-available/game.conf
    echo "    证书已生成，已写入 SSL 配置。"
  else
    echo "⚠ 证书未生成，保留 HTTP 配置（HTTPS 暂不可用，请排查后重跑脚本）。"
  fi
else
  # ---- 无域名：自建根 CA + 按服务器 IP 签发 ----
  echo "    (无域名模式) 自建根 CA + IP 证书"
  CA_KEY="$CERT_DIR/ca.key"; CA_CRT="$CERT_DIR/ca.crt"
  KEY="$CERT_DIR/server.key"; CERT="$CERT_DIR/server.crt"
  openssl genrsa -out "$CA_KEY" 2048
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 -out "$CA_CRT" \
    -subj "/CN=WebXR-Balloon-CA/O=SelfSigned"
  openssl req -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT_DIR/server.csr" \
    -subj "/CN=$SERVER_IP"
  printf "subjectAltName=IP:%s\n" "$SERVER_IP" > "$CERT_DIR/server.ext"
  openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$CERT" -days 3650 -sha256 -extfile "$CERT_DIR/server.ext"
  DOMAIN="_"
  cat >&2 <<EOF

================================================================
⚠ 无域名模式：已自建根 CA 并签发 IP 证书 ($SERVER_IP)。
   要使 PICO / 桌面浏览器信任它，需把根 CA 安装到设备（一次性）：
   1) 把根证书拷到电脑：  scp root@$SERVER_IP:$CA_CRT ./ca.crt
   2) 推到头显：          adb push ca.crt /sdcard/Download/   （或 U 盘拷贝）
   3) PICO：设置 -> 安全 -> 从存储安装证书 -> 选 ca.crt（类别选“CA 证书”）
   4) 桌面 Chrome：设置 -> 隐私和安全 -> 安全 -> 管理证书 -> 受信任的根证书颁发机构 -> 导入 ca.crt
   安装后访问 https://$SERVER_IP/ 即为受信任，WebXR 可用。
================================================================
EOF
  sed -e "s#__DOMAIN__#_#g" -e "s#__CERT__#$CERT#g" -e "s#__KEY__#$KEY#g" -e "s#__PORT__#$PORT#g" \
    "$CONF_SRC" > /etc/nginx/sites-available/game.conf
fi

ln -sf /etc/nginx/sites-available/game.conf /etc/nginx/sites-enabled/game.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> [6/6] 注册并启动授权服务（systemd）"
cp "$APP_DIR/deploy/license.service" /etc/systemd/system/license.service
systemctl daemon-reload
systemctl enable --now license
sleep 1
systemctl status license --no-pager | head -n 8 || true

echo "------------------------------------------------------------"
echo "部署完成。验证："
echo "  curl -k https://$SERVER_IP/api/activate -X POST -H 'Content-Type: application/json' -d '{\"machineId\":\"test\",\"product\":\"$PRODUCT\"}'"
echo "游戏入口： https://$SERVER_IP/   （客户端 SERVER_URL 须设为 https://$SERVER_IP）"
echo "------------------------------------------------------------"
