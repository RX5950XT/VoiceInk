"""
VoiceInk Icon Generator
概念：麥克風 + 聲波 + 墨水滴，代表語音轉文字
主色：indigo 漸層 #4338ca → #6366f1
"""
from PIL import Image, ImageDraw
import math
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def draw_gradient_rounded_rect(draw, bounds, radius, color_top, color_bottom):
    x0, y0, x1, y1 = bounds
    height = y1 - y0
    for y in range(y0, y1 + 1):
        t = (y - y0) / max(height, 1)
        r = int(color_top[0] + (color_bottom[0] - color_top[0]) * t)
        g = int(color_top[1] + (color_bottom[1] - color_top[1]) * t)
        b = int(color_top[2] + (color_bottom[2] - color_top[2]) * t)
        # 計算圓角裁切
        if y < y0 + radius:
            d = y0 + radius - y
            offset = int(radius - math.sqrt(max(0, radius ** 2 - d ** 2)))
            xs, xe = x0 + offset, x1 - offset
        elif y > y1 - radius:
            d = y - (y1 - radius)
            offset = int(radius - math.sqrt(max(0, radius ** 2 - d ** 2)))
            xs, xe = x0 + offset, x1 - offset
        else:
            xs, xe = x0, x1
        if xe > xs:
            draw.line([(xs, y), (xe, y)], fill=(r, g, b, 255))


def create_icon(size: int) -> Image.Image:
    scale = 4 if size <= 64 else 2
    w = h = size * scale

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── 背景漸層圓角方塊 ───────────────────────────────────────
    radius = int(w * 0.18)
    draw_gradient_rounded_rect(
        draw, (0, 0, w - 1, h - 1), radius,
        (67, 56, 202),   # #4338ca  深 indigo
        (99, 102, 241),  # #6366f1  中 indigo
    )

    cx, cy = w // 2, h // 2

    # ── 麥克風膠囊形狀 ────────────────────────────────────────
    mc_w = int(w * 0.26)
    mc_h = int(h * 0.37)
    mc_r = mc_w // 2

    mc_x0 = cx - mc_w // 2
    mc_y0 = int(h * 0.14)
    mc_x1 = cx + mc_w // 2
    mc_y1 = mc_y0 + mc_h

    draw.rounded_rectangle(
        [mc_x0, mc_y0, mc_x1, mc_y1],
        radius=mc_r,
        fill=(255, 255, 255, 252),
    )

    # 麥克風網格線（細節）
    line_y1 = mc_y0 + int(mc_h * 0.32)
    line_y2 = mc_y0 + int(mc_h * 0.64)
    lw = max(2, int(w * 0.011))
    margin = int(w * 0.04)
    for ly in (line_y1, line_y2):
        draw.line(
            [(mc_x0 + margin, ly), (mc_x1 - margin, ly)],
            fill=(129, 140, 248, 140),
            width=lw,
        )

    # ── 聲波弧線（左右各 3 條）────────────────────────────────
    wave_cy = (mc_y0 + mc_y1) // 2
    arc_lw = max(2, int(w * 0.027))
    for i in range(1, 4):
        arc_r = int(w * (0.18 + i * 0.07))
        alpha = max(40, 200 - i * 55)
        box = [cx - arc_r, wave_cy - arc_r, cx + arc_r, wave_cy + arc_r]
        draw.arc(box, start=140, end=220,
                 fill=(255, 255, 255, alpha), width=arc_lw)
        draw.arc(box, start=-40, end=40,
                 fill=(255, 255, 255, alpha), width=arc_lw)

    # ── 麥克風支架 ────────────────────────────────────────────
    stand_top = mc_y1
    stand_bottom = int(h * 0.725)
    sw = max(2, int(w * 0.022))
    draw.line([(cx, stand_top), (cx, stand_bottom)],
              fill=(255, 255, 255, 220), width=sw)

    # 水平底座
    base_half = int(w * 0.155)
    draw.line(
        [(cx - base_half, stand_bottom), (cx + base_half, stand_bottom)],
        fill=(255, 255, 255, 220), width=sw,
    )

    # ── 墨水滴（底座下方正中） ───────────────────────────────
    drop_rx = int(w * 0.048)
    drop_ry = int(w * 0.058)
    drop_cx = cx
    drop_cy = stand_bottom + int(h * 0.075)

    # 橢圓本體
    draw.ellipse(
        [drop_cx - drop_rx, drop_cy - drop_ry,
         drop_cx + drop_rx, drop_cy + drop_ry],
        fill=(255, 255, 255, 210),
    )
    # 尖端（三角形）
    tip_pts = [
        (drop_cx, drop_cy - drop_ry - int(h * 0.04)),
        (drop_cx - int(drop_rx * 0.55), drop_cy - drop_ry + int(drop_ry * 0.3)),
        (drop_cx + int(drop_rx * 0.55), drop_cy - drop_ry + int(drop_ry * 0.3)),
    ]
    draw.polygon(tip_pts, fill=(255, 255, 255, 210))

    # ── 縮小至目標尺寸（高品質 LANCZOS 反鋸齒）───────────────
    return img.resize((size, size), Image.LANCZOS)


def main():
    sizes = [16, 32, 48, 64, 128, 256]
    images = [create_icon(s) for s in sizes]

    ico_path = os.path.join(SCRIPT_DIR, "icon.ico")
    images[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[1:],
    )
    print(f"ICO saved → {ico_path}")

    # 同時儲存 PNG 預覽（256px）
    png_path = os.path.join(SCRIPT_DIR, "icon.png")
    images[-1].save(png_path, format="PNG")
    print(f"PNG saved → {png_path}")


if __name__ == "__main__":
    main()
