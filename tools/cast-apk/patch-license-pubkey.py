#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把**生产签发公钥**注入到两端的源码常量里（MainActivity.java 与 cast-pc/main.js），
并在注入前后各做一次「双口径哈希自证」。

    python tools/cast-apk/patch-license-pubkey.py            # 注入 + 自证
    python tools/cast-apk/patch-license-pubkey.py --check     # 只自证，不写文件
    python tools/cast-apk/patch-license-pubkey.py --fetch     # 强制重新向服务器取（换服务器密钥后用）
    python tools/cast-apk/patch-license-pubkey.py --url=https://别的域名

本地 `tools/_dist/pubkey-production.json` 不存在时会**自动**向 `https://webvr123.site/api/pubkey`
取一次并落盘（模板从零复现时走这条，不必手工造这个文件）。

## 为什么必须有这个脚本（而不是手抄）

2026-09-20 实测教训：**手抄 API 返回的 base64 公钥抄错了 1 个字符**，而
「长度 124 / DER 91 字节 / SPKI 头逐字节匹配 / 公钥点前缀 0x04 + 64 字节」这些结构性校验
**全部通过** —— 唯一能发现错误的是哈希。抄错公钥的后果是「所有 license 永远验不过」，
而且现象与「签名算法没对齐」一模一样，极难定位。

所以规则是：**密钥材料一律程序内取值**（从 tools/_dist/pubkey-production.json 读），
并用两条互相独立的哈希口径自证：

  ① sha256(DER)                       == derSha256        （DER = keyB64 按标准 base64 解码）
  ② sha256(PEM 文本)[:24]             == fingerprint      （PEM = SPKI PEM，64 列换行 + 结尾换行）

⚠️ 口径 ② 里的「结尾换行」是 2026-09-20 实测确认的：漏掉结尾换行会算出
`498fdfaf2e…` 而不是 `4156b73a…`。

产物必须是**两端逐字一致**：MainActivity.LICENSE_PUBKEY_B64 == main.js LICENSE_PUBKEY_B64。
"""
import base64
import hashlib
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SRC_JSON = os.path.join(ROOT, 'tools', '_dist', 'pubkey-production.json')
TARGETS = [
    ('APK  MainActivity.java', os.path.join(
        ROOT, 'tools', 'cast-apk', 'app', 'src', 'main', 'java', 'com', 'local', 'webxrcast',
        'MainActivity.java'), 'java'),
    ('EXE  main.js', os.path.join(ROOT, 'tools', 'cast-pc', 'main.js'), 'js'),
]
PLACEHOLDER = '__LICENSE_PUBKEY_B64__'


def pem_from_der(der: bytes) -> str:
    """DER → SPKI PEM（64 列换行 + 结尾换行，实测口径）"""
    b64 = base64.b64encode(der).decode('ascii')
    body = '\n'.join(b64[i:i + 64] for i in range(0, len(b64), 64))
    return '-----BEGIN PUBLIC KEY-----\n' + body + '\n-----END PUBLIC KEY-----\n'


def check_key(key_b64: str, fingerprint: str, der_sha256: str, label: str) -> bool:
    """双口径自证。任一条不过就返回 False（**绝不能带着不确定的密钥往下走**）"""
    ok = True
    try:
        der = base64.b64decode(key_b64, validate=True)
    except Exception as e:
        print('  [X] %s：keyB64 不是合法标准 base64（%s）' % (label, e))
        return False

    got_der = hashlib.sha256(der).hexdigest()
    if got_der == der_sha256:
        print('  [v] %s：sha256(DER) = %s（与 derSha256 一致）' % (label, got_der[:24] + '…'))
    else:
        print('  [X] %s：sha256(DER) 不一致\n        期望 %s\n        实得 %s'
              % (label, der_sha256, got_der))
        ok = False

    pem = pem_from_der(der)
    got_fp = hashlib.sha256(pem.encode('utf-8')).hexdigest()[:24]
    if got_fp == fingerprint:
        print('  [v] %s：sha256(PEM)[:24] = %s（与 fingerprint 一致）' % (label, got_fp))
    else:
        print('  [X] %s：PEM 口径指纹不一致\n        期望 %s\n        实得 %s'
              % (label, fingerprint, got_fp))
        ok = False

    # 结构旁证（**不作为通过依据**，只用于把「抄错」的形态在日志里显出来）
    print('      · 结构：长度 %d，DER %d 字节，SPKI 头 %s，公钥点前缀 0x%02x'
          % (len(key_b64), len(der), der[:7].hex(), der[-65]))
    return ok


def read_from_source(path: str, kind: str):
    """从源码里读回**当前实际生效**的常量值（这才是最终要相信的东西）"""
    s = io.open(path, encoding='utf-8').read()
    if kind == 'java':
        m = re.search(r'LICENSE_PUBKEY_B64\s*=\s*"([^"]*)"', s)
    else:
        m = re.search(r"LICENSE_PUBKEY_B64\s*=\s*'([^']*)'", s)
    return m.group(1) if m else None


def write_to_source(path: str, kind: str, value: str) -> bool:
    s = io.open(path, encoding='utf-8').read()
    if kind == 'java':
        new, n = re.subn(r'(LICENSE_PUBKEY_B64\s*=\s*")([^"]*)(")', r'\g<1>' + value + r'\g<3>', s, count=1)
    else:
        new, n = re.subn(r"(LICENSE_PUBKEY_B64\s*=\s*')([^']*)(')", r'\g<1>' + value + r'\g<3>', s, count=1)
    if n != 1:
        print('  [X] %s：没找到唯一的 LICENSE_PUBKEY_B64 赋值（n=%d）' % (path, n))
        return False
    if new != s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(new)
    return True


def fetch_pubkey(base_url: str) -> dict:
    """直接从授权服务器的 /api/pubkey 取（本地没有落盘文件时用；模板从零复现走这条）"""
    import urllib.request
    url = base_url.rstrip('/') + '/api/pubkey'
    req = urllib.request.Request(url, headers={'User-Agent': 'cast-license-pubkey-patcher'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    argv = sys.argv[1:]
    only_check = '--check' in argv
    force_fetch = '--fetch' in argv
    base_url = 'https://webvr123.site'
    for a in argv:
        if a.startswith('--url='):
            base_url = a.split('=', 1)[1]

    meta = None
    if os.path.isfile(SRC_JSON) and not force_fetch:
        meta = json.load(io.open(SRC_JSON, encoding='utf-8'))
        print('来源：本地落盘 %s' % SRC_JSON)
    else:
        why = '指定了 --fetch' if force_fetch else '本地没有落盘文件'
        print('来源：%s ⇒ 直接向 %s/api/pubkey 取' % (why, base_url))
        try:
            meta = fetch_pubkey(base_url)
        except Exception as e:
            print('取回失败：%s: %s' % (type(e).__name__, e))
            print('（服务器不可达时，请手工把 /api/pubkey 的返回存成 %s 再跑本脚本）' % SRC_JSON)
            return 2
        os.makedirs(os.path.dirname(SRC_JSON), exist_ok=True)
        # 把整份返回原样落盘：下次离线也能跑，且用双哈希自证它没被网络/落盘环节改坏
        io.open(SRC_JSON, 'w', encoding='utf-8', newline='\n').write(
            json.dumps(meta, ensure_ascii=False, indent=2) + '\n')
        print('已落盘 %s（下次离线可用）' % SRC_JSON)

    for k in ('keyB64', 'fingerprint', 'derSha256'):
        if not meta.get(k):
            print('返回里缺少 %s —— 服务器版本不对？' % k)
            return 2
    key_b64 = meta['keyB64']
    fingerprint = meta['fingerprint']
    der_sha256 = meta['derSha256']

    print()
    print('=== ① 自证来源（%s）===' % ('服务器 /api/pubkey' if force_fetch or not os.path.isfile(SRC_JSON) else 'tools/_dist/pubkey-production.json'))
    if not check_key(key_b64, fingerprint, der_sha256, 'production'):
        print('\n来源自身的哈希都对不上 —— 被改过或传输出错，**拒绝注入**。')
        return 1

    print()
    print('=== ② %s 注入 ===' % ('检查' if only_check else '写入'))
    for label, path, kind in TARGETS:
        if not os.path.isfile(path):
            print('  [X] %s：文件不存在 %s' % (label, path))
            return 2
        cur = read_from_source(path, kind)
        if cur is None:
            print('  [X] %s：源码里找不到 LICENSE_PUBKEY_B64 常量' % label)
            return 2
        state = '占位符（尚未注入）' if cur == PLACEHOLDER else (
            '已是生产公钥' if cur == key_b64 else '⚠ 是**别的**值（长度 %d）' % len(cur))
        print('  - %s 当前值：%s' % (label, state))
        if not only_check and cur != key_b64:
            if not write_to_source(path, kind, key_b64):
                return 2
            print('    已写入。')

    print()
    print('=== ③ 从源码读回、再自证一次（这才是最终生效的东西）===')
    all_ok = True
    for label, path, kind in TARGETS:
        cur = read_from_source(path, kind)
        if cur == PLACEHOLDER:
            print('  [X] %s：仍是占位符！带着它打包 = 所有 license 永远验不过' % label)
            all_ok = False
            continue
        if not check_key(cur, fingerprint, der_sha256, label):
            all_ok = False

    print()
    if not all_ok:
        print('[FAIL] 自证未全部通过 —— 不要打包，先查清楚。')
        return 1

    vals = [read_from_source(p, k) for _, p, k in TARGETS]
    if len(set(vals)) != 1:
        print('[FAIL] 两端公钥不一致（必须逐字一致）：')
        for (label, _, _), v in zip(TARGETS, vals):
            print('   %s = %s' % (label, v))
        return 1
    print('[OK] 两端逐字一致，双口径哈希全部通过。可以打包了。')
    print('     keyB64 = %s' % key_b64)
    return 0


if __name__ == '__main__':
    sys.exit(main())
