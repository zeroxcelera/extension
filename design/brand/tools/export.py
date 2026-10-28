"""Build the Celera brand assets from geometry.json (see trace.py).

Usage: python export.py geometry.json <out_dir>
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw

YELLOW = "#ffe066"
NAVY = "#0d1220"
LIGHT = "#e8ecf5"

geo = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
PTS = geo["outer"]


def catmull_rom(points, tension=0.5):
    """Closed Catmull-Rom spline through `points` as cubic Bezier segments."""
    n = len(points)
    segs = []
    for i in range(n):
        p0, p1, p2, p3 = points[i - 1], points[i], points[(i + 1) % n], points[(i + 2) % n]
        # Sharp corners (beak, wing and tail tips) stay sharp: no tangent across them.
        def turn(a, b, c):
            v1 = (b[0] - a[0], b[1] - a[1])
            v2 = (c[0] - b[0], c[1] - b[1])
            l1, l2 = math.hypot(*v1) or 1, math.hypot(*v2) or 1
            return (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
        t1 = tension / 3 if turn(p0, p1, p2) > -0.2 else 0
        t2 = tension / 3 if turn(p1, p2, p3) > -0.2 else 0
        c1 = (p1[0] + (p2[0] - p0[0]) * t1, p1[1] + (p2[1] - p0[1]) * t1)
        c2 = (p2[0] - (p3[0] - p1[0]) * t2, p2[1] - (p3[1] - p1[1]) * t2)
        segs.append((p1, c1, c2, p2))
    return segs


SEGS = catmull_rom(PTS)


def path_d(segs, tf):
    x, y = tf(segs[0][0])
    d = [f"M{x:.1f} {y:.1f}"]
    for _, c1, c2, p2 in segs:
        a, b, c = tf(c1), tf(c2), tf(p2)
        d.append(f"C{a[0]:.1f} {a[1]:.1f} {b[0]:.1f} {b[1]:.1f} {c[0]:.1f} {c[1]:.1f}")
    return "".join(d) + "Z"


def sample(segs, tf, steps=24):
    out = []
    for p1, c1, c2, p2 in segs:
        for s in range(steps):
            t = s / steps
            mt = 1 - t
            x = mt**3 * p1[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t**3 * p2[0]
            y = mt**3 * p1[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t**3 * p2[1]
            out.append(tf((x, y)))
    return out


def fit(size, scale, nudge=0.01):
    """Maps the 0..1000 bird box into a `size` square, bird spanning `scale` of it."""
    s = size * scale / 1000
    off = size * (1 - scale) / 2
    # Optical centering: the bird's mass sits right of centre (head), nudge it left a bit.
    return lambda p: (off + p[0] * s - size * nudge, off + p[1] * s)


def eyes_svg(tf, s):
    out = []
    for e in geo["eyes"]:
        cx, cy = tf(e["c"])
        out.append(
            f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{e["rx"] * s:.1f}" ry="{e["ry"] * s:.1f}" '
            f'transform="rotate({e["angle"]:.1f} {cx:.1f} {cy:.1f})" fill="{NAVY}"/>'
        )
    return "".join(out)


def svg_mark(size=1000, scale=1.0, bg=None, radius=0.22):
    tf = fit(size, scale)
    s = size * scale / 1000
    rect = f'<rect width="{size}" height="{size}" rx="{size * radius:.0f}" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">{rect}'
        f'<path d="{path_d(SEGS, tf)}" fill="{YELLOW}"/>{eyes_svg(tf, s)}</svg>\n'
    )


def small_eyes():
    """At 16-32 px two eyes merge into a smudge: keep the near one, enlarged."""
    e = min(geo["eyes"], key=lambda e: e["c"][0])
    return [{**e, "rx": e["rx"] * 1.7, "ry": e["ry"] * 1.5}]


def raster(size, scale, bg, radius=0.22, eyes=True, ss=8):
    big = size * ss
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bg:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * radius, fill=bg)
    tf = fit(big, scale, 0.01 if scale < 0.95 else 0)
    d.polygon(sample(SEGS, tf), fill=YELLOW)
    if eyes:
        s = big * scale / 1000
        for e in eyes if isinstance(eyes, list) else geo["eyes"]:
            cx, cy = tf(e["c"])
            # Draw the rotated ellipse as a polygon.
            a = math.radians(e["angle"])
            pts = []
            for k in range(64):
                t = 2 * math.pi * k / 64
                x, y = e["rx"] * s * math.cos(t), e["ry"] * s * math.sin(t)
                pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
            d.polygon(pts, fill=NAVY)
    return im.resize((size, size), Image.LANCZOS)


# ── Wordmark: custom geometric lowercase "celera", monoline with round ends ──────────
SW = 20  # stroke width in x-height units (x-height = 100)


def arc(cx, cy, r, a0, a1, n=48):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


R = 50 - SW / 2
GLYPHS = {
    # (strokes, advance). y grows down; x-height spans 0..100, ascender to -60.
    "c": ([arc(50, 50, R, -40, -320)], 92),
    "e": ([[(50 - R, 50), (50 + R, 50)] + arc(50, 50, R, 0, -320)[1:]], 100),
    "l": ([[(SW / 2, -62), (SW / 2, 100)]], SW),
    "r": ([[(SW / 2, 100), (SW / 2, 0)], [(SW / 2, 48)] + arc(SW / 2 + 40, 48, 40, 180, 268)], 60),
    "a": ([arc(50, 50, R, 0, 360), [(50 + R, 0), (50 + R, 100)]], 100),
}
GAP = 26


def wordmark_strokes():
    x, strokes = 0, []
    for ch in "celera":
        g, adv = GLYPHS[ch]
        strokes += [[(px + x, py) for px, py in s] for s in g]
        x += adv + GAP
    return strokes, x - GAP


def poly_d(pts, tf):
    return "M" + "L".join(f"{tf(p)[0]:.1f} {tf(p)[1]:.1f}" for p in pts)


def svg_lockup(text_color, bg=None):
    """Mascot + wordmark, horizontal. Height 200 units, x-height 100 centred."""
    strokes, width = wordmark_strokes()
    mark = 200
    gap = 56
    W = mark + gap + width + SW + 40
    H = 220
    tf_mark = fit(mark, 1.0)
    bird = f'<g transform="translate(10 10)"><path d="{path_d(SEGS, tf_mark)}" fill="{YELLOW}"/>{eyes_svg(tf_mark, mark / 1000)}</g>'
    ox, oy = 10 + mark + gap + SW / 2, 110 - 50 + 22
    tf = lambda p: (p[0] + ox, p[1] + oy)
    paths = "".join(
        f'<path d="{poly_d(s, tf)}" fill="none" stroke="{text_color}" stroke-width="{SW}" stroke-linecap="round" stroke-linejoin="round"/>'
        for s in strokes
    )
    rect = f'<rect width="{W:.0f}" height="{H}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H}">{rect}{bird}{paths}</svg>\n', W, H


def raster_lockup(text_color, out_w, out_h, bg, ss=4):
    strokes, width = wordmark_strokes()
    big_w, big_h = out_w * ss, out_h * ss
    im = Image.new("RGBA", (big_w, big_h), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    mark = 200
    gap = 56
    content_w = mark + gap + width + SW
    k = min(big_w * 0.72 / content_w, big_h * 0.5 / 200)
    x0 = (big_w - content_w * k) / 2
    y0 = (big_h - 200 * k) / 2
    tf_mark = lambda p: (x0 + p[0] * mark / 1000 * k, y0 + p[1] * mark / 1000 * k)
    d.polygon(sample(SEGS, tf_mark), fill=YELLOW)
    for e in geo["eyes"]:
        cx, cy = tf_mark(e["c"])
        s = mark / 1000 * k
        a = math.radians(e["angle"])
        pts = []
        for i in range(64):
            t = 2 * math.pi * i / 64
            x, y = e["rx"] * s * math.cos(t), e["ry"] * s * math.sin(t)
            pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
        d.polygon(pts, fill=NAVY)
    tx = x0 + (mark + gap + SW / 2) * k
    ty = y0 + (100 - 50 + 12) * k
    w = SW * k
    # Stamp a round brush along each stroke: exact round caps and joins, no seams on curves.
    for s in strokes:
        pts = [(tx + px * k, ty + py * k) for px, py in s]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            n = max(1, int(math.hypot(bx - ax, by - ay) / (w / 8)))
            for i in range(n + 1):
                x, y = ax + (bx - ax) * i / n, ay + (by - ay) * i / n
                d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=text_color)
    return im.resize((out_w, out_h), Image.LANCZOS)


def save(name, text):
    open(os.path.join(OUT, name), "w", encoding="utf-8").write(text)


save("celera-mark.svg", svg_mark())
save("celera-icon.svg", svg_mark(scale=0.8, bg=NAVY))
for color, suffix in ((LIGHT, "dark"), (NAVY, "light")):
    text, _, _ = svg_lockup(color)
    save(f"celera-lockup-on-{suffix}.svg", text)

png = os.path.join(OUT, "png")
os.makedirs(png, exist_ok=True)
for size in (16, 32):
    raster(size, 0.9, NAVY, eyes=small_eyes()).save(os.path.join(png, f"icon-{size}.png"))
for size in (48, 64, 128, 180, 192, 256, 512, 1024):
    raster(size, 0.8, NAVY).save(os.path.join(png, f"icon-{size}.png"))
# Android/PWA maskable: content inside the inner 80% safe circle, full-bleed background.
raster(512, 0.62, NAVY, radius=0).save(os.path.join(png, "icon-maskable-512.png"))
raster(1024, 1.0, None).save(os.path.join(png, "mark-1024.png"))
ico = [raster(16, 0.9, NAVY, eyes=small_eyes()), raster(32, 0.9, NAVY, eyes=small_eyes()), raster(48, 0.8, NAVY)]
ico[2].save(os.path.join(OUT, "favicon.ico"), append_images=ico[:2], sizes=[(16, 16), (32, 32), (48, 48)])
# Browser toolbar icons: no tile, the bird fills the box like other wallet icons. The 128 px
# store icon keeps Chrome Web Store's 16 px transparent margin (96 px artwork).
for size, scale in ((16, 1.0), (32, 1.0), (48, 0.96), (128, 0.75)):
    eyes = small_eyes() if size <= 32 else True
    raster(size, scale, None, eyes=eyes).save(os.path.join(png, f"toolbar-{size}.png"))
raster_lockup(LIGHT, 1200, 630, NAVY).save(os.path.join(png, "og-1200x630.png"))
raster_lockup(LIGHT, 1280, 640, NAVY).save(os.path.join(png, "github-social-1280x640.png"))
raster_lockup(LIGHT, 1200, 300, None).save(os.path.join(png, "lockup-on-dark.png"))
raster_lockup(NAVY, 1200, 300, None).save(os.path.join(png, "lockup-on-light.png"))
print("ok")


def mono_d(size=100, eyes=None):
    """Single path, eyes cut out (even-odd): takes any colour, eyes show the background."""
    tf = fit(size, 1.0)
    s = size / 1000
    d = path_d(SEGS, lambda p: tuple(round(v, 1) for v in tf(p)))
    for e in eyes or geo["eyes"]:
        cx, cy = tf(e["c"])
        rx, ry, a = e["rx"] * s, e["ry"] * s, math.radians(e["angle"])
        dx, dy = rx * math.cos(a), rx * math.sin(a)
        p1, p2 = (cx - dx, cy - dy), (cx + dx, cy + dy)
        d += (
            f"M{p1[0]:.1f} {p1[1]:.1f}A{rx:.1f} {ry:.1f} {e['angle']:.0f} 1 0 {p2[0]:.1f} {p2[1]:.1f}"
            f"A{rx:.1f} {ry:.1f} {e['angle']:.0f} 1 0 {p1[0]:.1f} {p1[1]:.1f}Z"
        )
    return d


save(
    "celera-mark-mono.svg",
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="{mono_d()}" fill="currentColor"/></svg>\n',
)
open(os.path.join(OUT, "mark-path.txt"), "w").write(mono_d() + "\n" + mono_d(eyes=small_eyes()))
