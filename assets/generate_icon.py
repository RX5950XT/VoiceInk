"""
VoiceInk Icon Generator
概念：與 App 內 header 相同的三色直條 brand mark（冷藍／暖金／薄荷）
底色：Aurora 深灰綠 #1b2124 → #0e1214，帶冷藍與暖金光暈
輸出：icon.ico（16～256）＋ icon.png ＋ icon_<size>.png
"""
import os

from PIL import Image, ImageDraw, ImageFilter

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 32, 48, 64, 128, 256]

BG_TOP = (34, 42, 45)
BG_BOTTOM = (16, 20, 22)
GLOW_COOL = (120, 163, 181)
GLOW_WARM = (212, 167, 91)
EDGE = (244, 241, 232)

# 直條：(高度比例, 顏色)，順序與 header 的 cool／warm／mint 一致
BARS = [
    (0.360, (119, 169, 188)),
    (0.530, (217, 170, 91)),
    (0.250, (101, 199, 149)),
]
BAR_WIDTH = 0.168
BAR_GAP = 0.062
BASELINE = 0.800


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    pixels = gradient.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        pixels[0, y] = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
    return gradient.resize((size, size), Image.BILINEAR).convert("RGBA")


def radial_glow(size: int, center: tuple, radius: float, color: tuple, alpha: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius]
    ImageDraw.Draw(layer).ellipse(box, fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.55))


def create_icon(size: int) -> Image.Image:
    scale = 8 if size <= 64 else 4
    s = size * scale

    canvas = vertical_gradient(s, BG_TOP, BG_BOTTOM)
    canvas.alpha_composite(radial_glow(s, (s * 0.14, s * 0.06), s * 0.66, GLOW_COOL, 120))
    canvas.alpha_composite(radial_glow(s, (s * 0.94, s * 1.02), s * 0.60, GLOW_WARM, 96))

    total_width = len(BARS) * BAR_WIDTH + (len(BARS) - 1) * BAR_GAP
    left = (1 - total_width) / 2 * s
    baseline = BASELINE * s
    width = BAR_WIDTH * s

    bars = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(bars)
    for index, (height_ratio, color) in enumerate(BARS):
        x0 = left + index * (BAR_WIDTH + BAR_GAP) * s
        y0 = baseline - height_ratio * s
        draw.rounded_rectangle(
            [x0, y0, x0 + width, baseline],
            radius=width / 2,
            fill=color + (255,),
        )

    glow = bars.filter(ImageFilter.GaussianBlur(s * 0.035))
    canvas.alpha_composite(Image.blend(Image.new("RGBA", (s, s), (0, 0, 0, 0)), glow, 0.55))
    canvas.alpha_composite(bars)

    radius = int(s * 0.215)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        [scale / 2, scale / 2, s - 1 - scale / 2, s - 1 - scale / 2],
        radius=radius,
        outline=EDGE + (34,),
        width=max(1, int(s * 0.008)),
    )
    canvas.putalpha(rounded_mask(s, radius))
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    images = [create_icon(s) for s in SIZES]

    # ICO 以最大張為基底：Pillow 只會往下縮，基底太小會讓其他尺寸整個消失
    ico_path = os.path.join(SCRIPT_DIR, "icon.ico")
    images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=images[:-1],
    )
    print('ICO saved -> %s' % ico_path)

    images[-1].save(os.path.join(SCRIPT_DIR, "icon.png"), format="PNG")
    for size, image in zip(SIZES, images):
        image.save(os.path.join(SCRIPT_DIR, "icon_%d.png" % size), format="PNG")
    print('PNG saved -> icon.png, icon_16..256.png')


if __name__ == "__main__":
    main()
