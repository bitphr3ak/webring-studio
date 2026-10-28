#!/usr/bin/env python3
"""
Generates every app icon and branded image from images/logo-icon.png.

Run from the repo root on macOS (uses the built-in `sips` and `iconutil`):

    python3 scripts/generate-icons.py

Outputs (all committed, so builds don't need macOS):
  build/icon.icns, build/icon.ico, build/icon.png      app icons for packagers (macOS, Windows, Linux)
  build/icons/<size>x<size>.png                        Linux icon set
  electron/assets/app-icon.png                         window / taskbar / dev dock icon
  electron/assets/splash-logo.png                      start-up splash logo
  electron/assets/trayTemplate.png, @2x               macOS menu bar (monochrome template)
  electron/assets/trayIcon.png, @2x                   Windows / Linux tray (colour)
  public/favicon.png, public/logo-mark.png             Studio window favicon and sidebar logo
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'images', 'logo-icon.png')


# --- Minimal PNG reading/writing (8-bit RGBA, non-interlaced), so no Pillow is needed ---

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'{path} is not a PNG'
    pos, idat, width, height = 8, b'', 0, 0
    color_type = None
    while pos < len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            width, height, depth, color_type, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            assert depth == 8 and color_type in (2, 6) and interlace == 0, 'need 8-bit RGB(A), non-interlaced'
        elif kind == b'IDAT':
            idat += chunk
        pos += 12 + length
    channels = 4 if color_type == 6 else 3
    raw = zlib.decompress(idat)
    stride = width * channels
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        rows.append(line)
        prev = line
    pixels = bytearray()
    for line in rows:
        if channels == 4:
            pixels += line
        else:
            for x in range(width):
                pixels += line[x * 3:x * 3 + 3] + b'\xff'
    return width, height, pixels


def write_png(path, width, height, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * width * 4:(y + 1) * width * 4]) for y in range(height))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def resize(src, size, dest):
    """High-quality resize with macOS sips, written as PNG."""
    subprocess.run(['sips', '-s', 'format', 'png', '-z', str(size), str(size), src, '--out', dest],
                   check=True, capture_output=True)


def pad(src, content, canvas, dest):
    """Centre the image, scaled to `content` px, on a transparent `canvas` px square."""
    tmp = dest + '.content.png'
    resize(src, content, tmp)
    w, h, px = read_png(tmp)
    out = bytearray(canvas * canvas * 4)
    off = (canvas - content) // 2
    for y in range(h):
        start = ((y + off) * canvas + off) * 4
        out[start:start + w * 4] = px[y * w * 4:(y + 1) * w * 4]
    write_png(dest, canvas, canvas, out)
    os.remove(tmp)


def tray_template(src, size, dest, work):
    """
    macOS menu bar icons must be single-colour shapes. Trace the logo's bright links (cyan and
    violet on the dark disc) into a black silhouette, skipping the outer glow ring.
    """
    big = os.path.join(work, f'tray-src-{size}.png')
    resize(src, size * 4, big)
    w, h, px = read_png(big)
    mask = bytearray(w * h * 4)
    cx, cy, r = (w - 1) / 2, (h - 1) / 2, w / 2
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 > r * 0.86:
                continue  # glow ring and border
            red, green, blue, alpha = px[i], px[i + 1], px[i + 2], px[i + 3]
            brightness = max(red, green, blue)
            level = min(255, max(0, (brightness - 70) * 255 // 110)) * alpha // 255
            mask[i + 3] = level
    traced = os.path.join(work, f'tray-mask-{size}.png')
    write_png(traced, w, h, mask)
    resize(traced, size, dest)


def write_ico(dest, pngs):
    """Windows .ico with PNG-compressed entries (supported since Windows Vista)."""
    entries = []
    for size, path in pngs:
        entries.append((size, open(path, 'rb').read()))
    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory, blobs = b'', b''
    for size, blob in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    with open(dest, 'wb') as f:
        f.write(header + directory + blobs)


def main():
    if sys.platform != 'darwin' or not shutil.which('sips') or not shutil.which('iconutil'):
        sys.exit('Run this on macOS: it uses the built-in sips and iconutil tools.')
    if not os.path.exists(SOURCE):
        sys.exit(f'Missing {SOURCE}')

    build = os.path.join(ROOT, 'build')
    assets = os.path.join(ROOT, 'electron', 'assets')
    public = os.path.join(ROOT, 'public')
    for d in (build, os.path.join(build, 'icons'), assets, public):
        os.makedirs(d, exist_ok=True)

    with tempfile.TemporaryDirectory() as work:
        # macOS: Apple's grid keeps artwork within ~824 of 1024 px, leaving a transparent margin
        mac_master = os.path.join(work, 'mac-1024.png')
        pad(SOURCE, 824, 1024, mac_master)
        iconset = os.path.join(work, 'icon.iconset')
        os.makedirs(iconset)
        for base in (16, 32, 128, 256, 512):
            resize(mac_master, base, os.path.join(iconset, f'icon_{base}x{base}.png'))
            resize(mac_master, base * 2, os.path.join(iconset, f'icon_{base}x{base}@2x.png'))
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(build, 'icon.icns')], check=True)

        # Windows and Linux icons use the full artwork (they don't add their own frame)
        ico_parts = []
        for size in (16, 24, 32, 48, 64, 128, 256):
            out = os.path.join(work, f'ico-{size}.png')
            resize(SOURCE, size, out)
            ico_parts.append((size, out))
        write_ico(os.path.join(build, 'icon.ico'), ico_parts)
        for size in (16, 32, 48, 64, 128, 256, 512, 1024):
            resize(SOURCE, size, os.path.join(build, 'icons', f'{size}x{size}.png'))
        resize(SOURCE, 1024, os.path.join(build, 'icon.png'))

        # Running from source: window/taskbar icon and macOS dock icon
        resize(SOURCE, 512, os.path.join(assets, 'app-icon.png'))
        resize(SOURCE, 560, os.path.join(assets, 'splash-logo.png'))  # shown at 280 px on the splash
        shutil.copy(mac_master, os.path.join(assets, 'dock-icon.png'))

        # Tray / menu bar
        tray_template(SOURCE, 16, os.path.join(assets, 'trayTemplate.png'), work)
        tray_template(SOURCE, 32, os.path.join(assets, 'trayTemplate@2x.png'), work)
        resize(SOURCE, 16, os.path.join(assets, 'trayIcon.png'))
        resize(SOURCE, 32, os.path.join(assets, 'trayIcon@2x.png'))

        # Studio window
        resize(SOURCE, 64, os.path.join(public, 'favicon.png'))
        resize(SOURCE, 256, os.path.join(public, 'logo-mark.png'))

    print('Icons generated from images/logo-icon.png')


if __name__ == '__main__':
    main()
