#!/usr/bin/env python
# 裁切 Picture/ 下的 3 张抽卡选项卡 PNG：去掉透明留白，输出到 assets/cards/{id}.png
# 用法：python tools/trim-card-images.py
import os
import struct
import zlib
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "Picture")
OUT_DIR = os.path.join(ROOT, "assets", "cards")
PAD = 8  # 裁切边距，避免裁掉抗锯齿边缘
MAX_SIDE = 1024  # 裁切后最长边上限（卡面在 VR 中很小，1024 足够清晰，省 VRAM/带宽）

# 源文件名 -> 输出 id（对应 cards.js 的 ATTR_TYPES.id）
MAPPING = {
    "速度选项卡.png": "fireRate",   # 攻击速度加倍
    "攻击力选项卡.png": "atk",       # 攻击力加倍
    "额外子弹选项卡.png": "multiShot",  # 额外发射一枚子弹
}


def trim_alpha(path, pad):
    """返回去掉透明区域后的裁切图（RGBA）。"""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 0:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < 0:
        raise RuntimeError(f"no opaque pixels in {path}")
    min_x = max(0, min_x - pad)
    min_y = max(0, min_y - pad)
    max_x = min(w - 1, max_x + pad)
    max_y = min(h - 1, max_y + pad)
    cropped = im.crop((min_x, min_y, max_x + 1, max_y + 1))
    # 限制最长边，避免大图占 VRAM / 带宽
    cw, ch = cropped.size
    longest = max(cw, ch)
    if longest > MAX_SIDE:
        scale = MAX_SIDE / longest
        cropped = cropped.resize((int(cw * scale + 0.5), int(ch * scale + 0.5)), Image.LANCZOS)
    return cropped, (w, h), (min_x, min_y, max_x, max_y)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for fname, out_id in MAPPING.items():
        src = os.path.join(SRC_DIR, fname)
        if not os.path.exists(src):
            print(f"[skip] missing {src}")
            continue
        cropped, full, box = trim_alpha(src, PAD)
        out = os.path.join(OUT_DIR, f"{out_id}.png")
        cropped.save(out, "PNG")
        cw, ch = cropped.size
        print(f"[ok] {fname} -> {out_id}.png  size={cw}x{ch}  aspect={cw/ch:.3f}  crop_box={box} (full {full})")


if __name__ == "__main__":
    main()
