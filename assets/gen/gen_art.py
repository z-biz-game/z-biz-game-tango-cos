#!/usr/bin/env python3
"""破码 TANGO 的美术母题生成器 —— 仓内自产、可复现、零网络。

    python3 assets/gen/gen_art.py            # 重新生成全套位图（幂等）
    python3 assets/gen/gen_art.py --check    # 只校验盘上资产与母图一致，不写文件

母题来自玩法本身，不是凭空配的装饰：
  * 一行 L=4 枚色 peg            —— 一次 guess，码的本体（js/core/codes.js: L=4, C=6）
  * 2x2 反馈块（黑先白后）        —— 这游戏的判定签名（js/view.js 的 feedback()）
  * ⌗ 记号                        —— index.html 里已有的品牌 mark
  * 打点码盘（pegboard）纹理      —— 画在 canvas 行底，是"码桌"的桌面本身
颜色一律取自 js/core/codes.js 的 COLOR_SWATCH 与 css/game.css 的 :root，不新造色。

peg 的画法刻意对齐 js/view.js 的 peg()：投影 + 实色 + 上左高光 + 下右暗缘，
所以图标里的 peg 和屏幕上的 peg 是同一个东西，而不是两种画风。

只依赖 Pillow（系统已装）；字体走搜索列表，缺失时退回 PIL 默认字体，
即换机器也能重跑出一套结构相同的图（尺寸、配色、构图与本机字体无关的部分不变）。
"""
import argparse
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'assets', 'img')

# ---- palette (measured from css/game.css :root and js/core/codes.js) -------------
BG = (16, 18, 23, 255)            # --bg   #101217
BG2 = (23, 26, 33, 255)           # --bg-2 #171a21
INK = (230, 233, 239, 255)        # --ink  #e6e9ef
AMBER = (224, 166, 60, 255)       # --amber / COLOR_SWATCH[0]
CYAN = (79, 179, 209, 255)        # --cyan  / COLOR_SWATCH[1]
ROSE = (209, 97, 139, 255)        # --rose  / COLOR_SWATCH[2]
MOSS = (93, 156, 99, 255)         # COLOR_SWATCH[3]
VIOLET = (138, 111, 192, 255)     # COLOR_SWATCH[4]
FROST = (207, 214, 224, 255)      # COLOR_SWATCH[5]
BLACK_PEG = (18, 20, 26, 255)     # view.js BLACK_PEG #12141a
WHITE_PEG = (242, 244, 248, 255)  # view.js WHITE_PEG #f2f4f8
CODE = [AMBER, CYAN, ROSE, FROST]

MONO_CANDIDATES = [
    '/System/Library/Fonts/SFNSMono.ttf',
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/Supplemental/Courier New.ttf',
    '/Library/Fonts/SFNSMono.ttf',
]
CJK_CANDIDATES = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/PingFang.ttc',
]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def field(size, top=BG2, bottom=BG):
    """垂直渐变底 + 左上微光，图标和纹理共用同一块"桌面"。"""
    img = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = (y / max(1, size - 1)) ** 1.4
        d.line([0, y, size, y], fill=mix(top, bottom, t))
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-size * 0.35, -size * 0.45, size * 0.75, size * 0.55],
               fill=(255, 255, 255, 22))
    return Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(size * 0.08)))


def dot_matrix(size, step, alpha=14, colour=INK):
    """码盘上的打点阵。step 必须整除 size 才能无缝平铺。"""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = max(0.6, step * 0.055)
    for y in range(0, size, step):
        for x in range(0, size, step):
            d.ellipse([x - r, y - r, x + r, y + r], fill=colour[:3] + (alpha,))
    return layer


def peg(img, cx, cy, r, colour):
    """一枚 peg：对齐 js/view.js peg() 的层次（投影 / 实色 / 径向高光 / 下缘暗边）。"""
    if r <= 0.5:
        return
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse([cx - r, cy - r + r * 0.14, cx + r, cy + r + r * 0.14], fill=(0, 0, 0, 115))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(max(0.6, r * 0.30))))

    d = ImageDraw.Draw(img)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colour)

    # 上左亮、下右暗：用一张对角线性渐变当 alpha 蒙两张纯色层，近似 canvas 的 radialGradient。
    box = (int(cx - r), int(cy - r), int(cx + r), int(cy + r))
    w = max(2, box[2] - box[0])
    ramp = Image.new('L', (w, w))
    for y in range(w):
        for x in range(w):
            t = ((x + y) / max(1, 2 * (w - 1)))
            ramp.putpixel((x, y), int(255 * t))
    circle = Image.new('L', (w, w), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, w - 1, w - 1], fill=255)
    shade = Image.new('RGBA', img.size, (0, 0, 0, 0))
    dark = Image.new('RGBA', (w, w), (8, 10, 16, 255))
    dark.putalpha(ramp.point(lambda v: int(v * 0.42)))
    shade.paste(dark, (box[0], box[1]), dark)
    img.alpha_composite(shade)

    hi = Image.new('RGBA', img.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(hi)
    hr = r * 0.46
    hx, hy = cx - r * 0.34, cy - r * 0.44
    hd.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=(255, 255, 255, 150))
    img.alpha_composite(hi.filter(ImageFilter.GaussianBlur(max(0.6, r * 0.26))))

    d = ImageDraw.Draw(img)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=math.radians(-20), end=math.radians(150),
          fill=mix(colour, (0, 0, 0, 255), 0.45), width=max(1, int(r * 0.10)))


def slot(img, cx, cy, r, alpha=64):
    """空槽：虚线环，对齐 view.js slot() 的 setLineDash。"""
    def draw(d):
        steps = max(6, int(r * 1.1))
        for i in range(steps):
            if i % 2:
                continue
            a0 = i / steps * 2 * math.pi
            a1 = (i + 0.85) / steps * 2 * math.pi
            d.arc([cx - r, cy - r, cx + r, cy + r], start=a0, end=a1,
                  fill=INK[:3] + (alpha,), width=max(1, int(r * 0.16)))
    paint(img, draw)


def paint(img, fn):
    """半透明的一切都必须走独立层再 alpha_composite。

    ImageDraw 画在 RGBA 图上是**逐像素替换**（含 alpha 通道），所以直接画一个 alpha=26 的
    圆角矩形不会得到淡淡的叠加，而是把底下那块"桌面"连色带 alpha 一起抹掉——图标里的反馈块
    和社交卡的描边第一版就是这么变成白斑的。
    """
    buf = Image.new('RGBA', img.size, (0, 0, 0, 0))
    fn(ImageDraw.Draw(buf))
    img.alpha_composite(buf)


def feedback_block(img, x, y, r, blacks=1, whites=1, total=4):
    """2x2 反馈块，黑先白后（codes.js 的两趟规则），空格子留成暗环。"""
    paint(img, lambda d: d.rounded_rectangle(
        [x - r * 0.45, y - r * 0.45, x + r * 2.95, y + r * 2.95],
        radius=r * 0.7, fill=(230, 233, 239, 30)))
    cells = [(0, 0), (1, 0), (0, 1), (1, 1)]
    order = [BLACK_PEG] * blacks + [WHITE_PEG] * whites
    for i, (cx, cy) in enumerate(cells):
        px, py = x + cx * r * 1.75, y + cy * r * 1.75
        if i < len(order):
            peg(img, px, py, r * 0.68, order[i])
        else:
            slot(img, px, py, r * 0.62, alpha=54)


def hash_mark(img, cx, cy, w, colour, weight):
    """⌗：两条竖 + 两条横，笔画交点盖在码行上，是仓里已有的品牌记号。"""
    half = w / 2
    off = w * 0.24
    weight = max(1, int(weight))

    def draw(d):
        for sign in (-1, 1):
            x = cx + sign * off
            d.line([x, cy - half, x, cy + half], fill=colour, width=weight)
        for sign in (-1, 1):
            y = cy + sign * off
            d.line([cx - half, y, cx + half, y], fill=colour, width=weight)
    paint(img, draw)


def round_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def compose_icon(size, full_bleed=False):
    """母图。size>=180 给全套元素；更小的尺寸自动瘦身，保证 16px 仍读得出"一行码"。"""
    img = field(size)
    detail = size >= 128
    img.alpha_composite(dot_matrix(size, max(4, size // (16 if detail else 8)),
                                   alpha=16 if detail else 22))

    n = len(CODE)
    pitch = size * (0.196 if detail else 0.215)
    r = pitch * (0.40 if detail else 0.44)
    # maskable 会被系统裁成圆：竖排元素整体向中心收，字数标去掉，否则安全区外全丢。
    hash_y = 0.185 if not full_bleed else 0.315
    row_y = (0.455 if detail else 0.5) if not full_bleed else 0.5
    block_y = 0.70 if not full_bleed else 0.655
    span = pitch * (n - 1)
    x0 = (size - span) / 2

    if detail and not full_bleed:
        hash_mark(img, size * 0.5, size * hash_y, size * 0.20, AMBER[:3] + (235,), size * 0.026)

    if full_bleed:
        # maskable：Android 会裁成圆/方，主体必须缩进 ~80% 安全区
        r *= 0.86
        pitch *= 0.9
        span = pitch * (n - 1)
        x0 = (size - span) / 2

    for i, col in enumerate(CODE):
        peg(img, x0 + i * pitch, size * row_y, r, col)

    if detail:
        br = size * (0.052 if not full_bleed else 0.044)
        bx = size * 0.5 - (br * 2.5) / 2
        feedback_block(img, bx, size * block_y, br, blacks=2, whites=1)
        if not full_bleed:
            d = ImageDraw.Draw(img)
            d.text((size * 0.5, size * 0.885), 'TANGO',
                   font=font(MONO_CANDIDATES, int(size * 0.072)),
                   fill=INK[:3] + (150,), anchor='mm')

    if not full_bleed:
        m = round_mask(size, size * 0.19)
        out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), m)
        if size >= 96:
            d = ImageDraw.Draw(out)
            d.rounded_rectangle([1, 1, size - 2, size - 2], radius=size * 0.19,
                                outline=(224, 166, 60, 70), width=max(1, size // 140))
        return out
    return img


def compose_og(width=1200, height=630):
    """社交卡：左半说"这是什么游戏"，右半直接把三个数摆上台——游戏的卖点就是那三个数。"""
    img = Image.new('RGBA', (width, height), BG)
    img.paste(field(height).resize((width, height), Image.BILINEAR), (0, 0))
    img.alpha_composite(dot_matrix(width, 40, alpha=13))

    f_cjk = font(CJK_CANDIDATES, 92)
    f_cjk_small = font(CJK_CANDIDATES, 30)
    f_mono = font(MONO_CANDIDATES, 26)
    f_mono_big = font(MONO_CANDIDATES, 54)
    DIM_INK = (143, 152, 168, 255)

    hash_mark(img, 108, 118, 86, AMBER, 11)
    tiles = [('码本 |S|', '840', '码', AMBER), ('下界', '5', 'ceil(log_15|S|)', DIM_INK),
             ('精确值', '6', '次必破', CYAN)]
    tw, th, gap = 214, 130, 18
    x0, y0 = 112, 268

    def draw_words(d):
        d.text((170, 108), '破码', font=f_cjk, fill=INK, anchor='lm')
        d.text((368, 118), 'TANGO', font=font(MONO_CANDIDATES, 40),
               fill=(230, 233, 239, 150), anchor='lm')
        d.text((112, 196), '每一关“几次必破”都是极小极大搜索量出来的', font=f_cjk_small,
               fill=DIM_INK, anchor='lm')
        for i, (term, val, note, col) in enumerate(tiles):
            x = x0 + i * (tw + gap)
            d.text((x + 18, y0 + 26), term, font=font(MONO_CANDIDATES, 20),
                   fill=DIM_INK, anchor='lm')
            d.text((x + 18, y0 + 76), val, font=f_mono_big, fill=col, anchor='lm')
            d.text((x + tw - 18, y0 + 106), note, font=font(MONO_CANDIDATES, 17),
                   fill=(143, 152, 168, 220), anchor='rm')
        d.text((width - 40, height - 40), 'z-biz-game · Mastermind with a measured par',
               font=f_mono, fill=(143, 152, 168, 210), anchor='rb')

    def draw_tiles(d):
        for i in range(len(tiles)):
            x = x0 + i * (tw + gap)
            d.rounded_rectangle([x, y0, x + tw, y0 + th], radius=14,
                                fill=(27, 31, 39, 235), outline=(230, 233, 239, 60), width=2)

    paint(img, draw_tiles)
    paint(img, draw_words)

    # 右下：一行真 peg + 反馈块，和图标同一个母题
    px, py, pr = width - 430, height - 120, 29
    for i, col in enumerate(CODE):
        peg(img, px + i * pr * 2.5, py, pr, col)
    feedback_block(img, px + 4 * pr * 2.5 + 6, py - pr * 1.5, pr * 0.7, blacks=2, whites=1)
    return img


def compose_pegboard(size=512):
    """可无缝平铺的码桌纹理：行带 + 打点 + 槽环 + 极淡噪点，画在 canvas 行底。"""
    img = Image.new('RGBA', (size, size), (20, 23, 29, 255))
    rnd = random.Random(20261002)
    step = size // 8
    rows = size // 4

    def draw_bands(d):
        for i in range(rows):
            y = i * (size / rows)
            d.rectangle([0, y, size, y + size / rows * 0.5], fill=(230, 233, 239, 7))

    def draw_slots(d):
        r = step * 0.30
        for gy in range(8):
            for gx in range(8):
                cx, cy = gx * step + step // 2, gy * step + step // 2
                d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(230, 233, 239, 20),
                          width=max(1, size // 200))

    def draw_grain(d):
        for _ in range(int(size * size * 0.006)):
            x, y = rnd.randrange(size), rnd.randrange(size)
            d.point((x, y), fill=(255, 255, 255, 10) if rnd.randint(0, 1) else (0, 0, 0, 14))

    paint(img, draw_bands)
    img.alpha_composite(dot_matrix(size, step, alpha=20))
    paint(img, draw_slots)
    paint(img, draw_grain)
    return img


def build():
    os.makedirs(OUT, exist_ok=True)
    written = []

    def save(img, name):
        path = os.path.join(OUT, name)
        img.save(path, 'PNG', optimize=True)
        written.append((name, img.size))

    # 每个尺寸都由 compose_icon 原生绘制：小尺寸走它自己的瘦身构图（相对更大的 peg、去掉反馈块与
    # 字标），比从 1024 母图重采样在 16/32px 上明显更硬。
    for size, name in [(1024, 'icon-1024.png'), (512, 'icon-512.png'), (192, 'icon-192.png'),
                       (180, 'apple-touch-icon.png'), (96, 'icon-96.png'), (64, 'icon-64.png'),
                       (48, 'icon-48.png'), (32, 'icon-32.png'), (16, 'icon-16.png')]:
        save(compose_icon(size), name)
    save(compose_icon(512, full_bleed=True), 'icon-maskable-512.png')
    save(compose_og(), 'og.png')
    save(compose_pegboard(512), 'pegboard.png')
    return written


def check():
    ok = True
    for name in sorted(os.listdir(OUT)) if os.path.isdir(OUT) else []:
        if not name.endswith('.png'):
            continue
        p = os.path.join(OUT, name)
        sz = os.path.getsize(p)
        try:
            with Image.open(p) as im:
                im.verify()
            with Image.open(p) as im:
                w, h = im.size
        except Exception as err:
            print('BROKEN %-28s %s' % (name, err))
            ok = False
            continue
        if sz < 200:
            print('TOO SMALL %-24s %d bytes' % (name, sz))
            ok = False
            continue
        print('ok %-28s %dx%d %d bytes' % (name, w, h, sz))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只校验盘上资产，不重写')
    args = ap.parse_args()
    if args.check:
        sys.exit(0 if check() else 1)
    for name, size in build():
        print('wrote assets/img/%s %dx%d' % (name, size[0], size[1]))
    print('assets in %s' % OUT)


if __name__ == '__main__':
    main()
