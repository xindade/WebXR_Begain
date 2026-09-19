#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线转换全景图：8K PNG → 4K JPG（减轻 PICO 移动端 CPU 解码压力）。
用法（先确保已安装 pillow）：
    python tools/convert-pano.py
输入：Sky/01关/早晨天空.png  (7680x3840)
输出：Sky/01关/早晨天空.jpg  (4096x2048, quality=85)
"""
import os
from PIL import Image

SRC = os.path.join('Sky', '01关', '早晨天空.png')
DST = os.path.join('Sky', '01关', '早晨天空.jpg')
TARGET = (4096, 2048)  # 4K 等距全景（2:1）
QUALITY = 85


def main():
    if not os.path.isfile(SRC):
        raise SystemExit(f'[convert-pano] 源文件不存在: {SRC}')
    with Image.open(SRC) as im:
        print(f'[convert-pano] 源: {SRC} size={im.size} mode={im.mode}')
        if im.mode != 'RGB':
            im = im.convert('RGB')
        im = im.resize(TARGET, Image.LANCZOS)
        os.makedirs(os.path.dirname(DST), exist_ok=True)
        im.save(DST, 'JPEG', quality=QUALITY, optimize=True)
    kb = os.path.getsize(DST) / 1024
    print(f'[convert-pano] 输出: {DST} ({kb:.0f} KB)')


if __name__ == '__main__':
    main()
