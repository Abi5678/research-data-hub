"""Generate the Fieldbook app icon: build/icon.png, icon.icns and icon.ico.

    python3 scripts/make-icon.py

Needs Pillow and, for the .icns, macOS's built-in `iconutil`. The icon is drawn
here rather than checked in as an opaque binary so that a colour or a proportion
can be changed without a design tool.

Two shapes only, because it has to survive being 16px in the Dock and in
Finder's list view: a page, and the IDEAL-CT load curve drawn across it. The
tile colour is the app's own --primary (#4F46E5, src/styles.css).
"""

import math
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw

S = 4  # supersample factor; the whole icon is drawn at 4x and downsampled
N = 1024 * S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")

TOP = (99, 102, 241)  # indigo-500
BOT = (67, 56, 202)  # indigo-700
PAGE = (255, 255, 255)
CURVE = (49, 46, 129)  # indigo-900, reads as near-black at small sizes
AXIS = (199, 210, 254)  # indigo-200


def px(v):
    return int(round(v * S))


def stroke(draw, pts, width, fill):
    """A round-capped, round-joined stroke: the union of discs along the path."""
    r = width / 2
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / (r / 3)))
        for s in range(steps + 1):
            t = s / steps
            cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def draw_icon():
    # Tile: vertical gradient clipped to a rounded square.
    grad = Image.new("RGB", (1, 1024 * S))
    for y in range(grad.height):
        t = y / (grad.height - 1)
        grad.putpixel(
            (0, y), tuple(int(round(TOP[i] + (BOT[i] - TOP[i]) * t)) for i in range(3))
        )
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=px(229), fill=255)

    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    img.paste(grad.resize((N, N)), (0, 0), mask)
    d = ImageDraw.Draw(img)

    # Page.
    d.rounded_rectangle([px(232), px(190), px(792), px(834)], radius=px(46), fill=PAGE)

    # Axes: faint, meeting at the origin.
    AX0, AY1 = px(324), px(748)
    AX1, AY0 = px(706), px(312)
    T = px(15)
    d.rectangle([AX0, AY0, AX0 + T, AY1 + T], fill=AXIS)
    d.rectangle([AX0, AY1, AX1, AY1 + T], fill=AXIS)

    # The curve: f(t) = (t/tp)^k * exp(k(1 - t/tp)) peaks at t=tp with value 1 --
    # the shape of a load/displacement trace, which is what this app is for. It
    # starts clear of the y axis because its rising limb is steep enough to
    # swallow the axis entirely, which left a stray-looking stub.
    #
    # Stamped as discs rather than an ImageDraw polyline: PIL's thick-line joints
    # leave a visible comb along the outside of a tight bend, and the peak of
    # this curve is exactly that.
    TP, K = 0.42, 2.0
    X0 = AX0 + px(38)
    pts = []
    for i in range(321):
        t = i / 320
        f = 0.0 if t <= 0 else (t / TP) ** K * math.exp(K * (1 - t / TP))
        pts.append((X0 + (AX1 - X0) * t, AY1 - (AY1 - AY0) * f))
    stroke(d, pts, px(42), CURVE)

    return img.resize((1024, 1024), Image.LANCZOS)


def main():
    os.makedirs(BUILD, exist_ok=True)
    icon = draw_icon()

    png = os.path.join(BUILD, "icon.png")
    icon.save(png)
    # Windows. Pillow writes every listed size into the one .ico.
    icon.save(
        os.path.join(BUILD, "icon.ico"),
        sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)],
    )

    # macOS. iconutil wants a directory of exactly these names.
    iconset = os.path.join(BUILD, "icon.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            s = base * scale
            suffix = "@2x" if scale == 2 else ""
            icon.resize((s, s), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{base}x{base}{suffix}.png")
            )
    try:
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", os.path.join(BUILD, "icon.icns")],
            check=True,
        )
    except FileNotFoundError:
        print("iconutil not found (macOS only) -- icon.icns not regenerated", file=sys.stderr)
    finally:
        shutil.rmtree(iconset, ignore_errors=True)

    print(f"wrote icon.png, icon.ico and icon.icns to {BUILD}")


if __name__ == "__main__":
    main()
