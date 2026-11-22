#!/usr/bin/env python3
"""生成 macOS app 图标（AppIcon.icns）。不依赖设计工具，改完直接跑。

构图：深色圆角方块 + 三行"收件箱"横条 + 右下角绿色对勾 —— 一眼能看出"待办清单，人只勾选"。
"""
import subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = Path(__file__).resolve().parent.parent / "apps" / "macshell" / "AppIcon.icns"


def rounded(size, radius, fill):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=fill)
    return img


def main():
    # 背景：竖直渐变 + 大圆角（macOS 会再自己裁一次，但预览里也要好看）
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    top, bot = (32, 41, 55), (15, 20, 30)
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        t = y / (S - 1)
        grad.putpixel((0, y), tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    grad = grad.resize((S, S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
    bg.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(bg)
    # 三行横条（收件箱），越往下越短，暗示"队列"
    rows = [(0.28, 0.60), (0.44, 0.52), (0.60, 0.40)]
    for y, w in rows:
        x0, x1 = int(S * 0.18), int(S * (0.18 + w * 0.62))
        y0 = int(S * y)
        d.rounded_rectangle([x0, y0, x1, y0 + int(S * 0.075)], radius=int(S * 0.037), fill=(236, 240, 244, 235))

    # 对勾：绿色圆 + 白勾，压在右下（"人只负责这一下"）
    cx, cy, r = int(S * 0.70), int(S * 0.70), int(S * 0.20)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(34, 160, 90, 255))
    d.line([(cx - r * 0.45, cy + r * 0.03), (cx - r * 0.10, cy + r * 0.38), (cx + r * 0.50, cy - r * 0.34)],
           fill=(255, 255, 255, 255), width=int(S * 0.055), joint="curve")

    with tempfile.TemporaryDirectory() as tmp:
        setdir = Path(tmp) / "AppIcon.iconset"
        setdir.mkdir()
        for base in [16, 32, 128, 256, 512]:
            for scale, suffix in [(1, ""), (2, "@2x")]:
                px = base * scale
                if px > 1024:
                    continue
                bg.resize((px, px), Image.LANCZOS).save(setdir / f"icon_{base}x{base}{suffix}.png")
        subprocess.run(["iconutil", "-c", "icns", str(setdir), "-o", str(OUT)], check=True)
    print("图标:", OUT, OUT.stat().st_size, "字节")


if __name__ == "__main__":
    sys.exit(main())
