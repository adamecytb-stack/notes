#!/usr/bin/env python3
"""
Generates the app icons: an ember crescent on warm ink, matching the Nocturne
palette. Re-run with `python3 scripts/make-icons.py` if the palette changes.
"""

from PIL import Image, ImageDraw
import os

INK = (12, 10, 9, 255)
EMBER = (232, 149, 90, 255)
MOON = (157, 180, 192, 255)

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
SS = 8  # supersample factor for clean edges


def crescent(size, *, padding_ratio, rounded, bg=INK):
    """Draws the mark at `size`px. `padding_ratio` leaves room for maskable safe zones."""
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        # iOS applies its own mask; a plain square with full-bleed colour is right.
        d.rectangle([0, 0, s, s], fill=bg)
    else:
        d.rectangle([0, 0, s, s], fill=bg)

    inset = s * padding_ratio
    box = s - inset * 2
    r = box * 0.42
    cx, cy = s / 2, s / 2

    # Outer disc, then a second disc punched out of it to leave a crescent.
    moon = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    md = ImageDraw.Draw(moon)
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=EMBER)

    cut = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cut)
    offset = r * 0.46
    cr = r * 0.94
    cd.ellipse([cx - cr + offset, cy - cr - offset * 0.25, cx + cr + offset, cy + cr - offset * 0.25],
               fill=(0, 0, 0, 255))

    moon_px = moon.load()
    cut_px = cut.load()
    for y in range(s):
        for x in range(s):
            if cut_px[x, y][3] > 0:
                moon_px[x, y] = (0, 0, 0, 0)

    img.alpha_composite(moon)

    # A small companion star, echoing the lock-screen mark.
    sr = r * 0.11
    sx, sy = cx + r * 0.62, cy - r * 0.72
    d2 = ImageDraw.Draw(img)
    d2.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=MOON)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)

    # Home-screen icon for iOS (no transparency, iOS rounds the corners itself).
    crescent(180, padding_ratio=0.16, rounded=True).convert('RGB').save(
        os.path.join(OUT, 'apple-touch-icon.png'))

    # Standard PWA icons.
    for size in (192, 512):
        crescent(size, padding_ratio=0.16, rounded=True).save(
            os.path.join(OUT, f'icon-{size}.png'))

    # Maskable: art stays inside the inner 80% so Android can crop any shape.
    for size in (192, 512):
        crescent(size, padding_ratio=0.26, rounded=True).save(
            os.path.join(OUT, f'maskable-{size}.png'))

    print('wrote icons to', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
