"""Renders the Rundor logo (white peak on orange) to PNG icons with a tiny pure-Python encoder."""
import os
import struct
import sys
import zlib

ORANGE = (0xFC, 0x4C, 0x02)
WHITE = (0xFF, 0xFF, 0xFF)
# Same shape as the CSS clip-path of .logo, in unit coordinates.
LOGO = [(0.5, 0.0), (1.0, 1.0), (0.72, 1.0), (0.5, 0.55), (0.28, 1.0), (0.0, 1.0)]
SUPERSAMPLE = 3


def inside(x, y, poly):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def render(size, logo_scale):
    offset = (1 - logo_scale) / 2
    poly = [(offset + x * logo_scale, offset + 0.04 + y * logo_scale) for x, y in LOGO]
    rows = []
    n = SUPERSAMPLE
    for py in range(size):
        row = bytearray([0])  # filter type 0
        for px in range(size):
            covered = 0
            for sy in range(n):
                for sx in range(n):
                    if inside((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size, poly):
                        covered += 1
            a = covered / (n * n)
            row += bytes(round(ORANGE[c] * (1 - a) + WHITE[c] * a) for c in range(3))
        rows.append(bytes(row))
    return b''.join(rows)


def write_png(path, size, pixels):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b''))


out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
# Maskable icons keep the logo inside the central 80% safe zone.
for name, size, scale in [('icon-192.png', 192, 0.56), ('icon-512.png', 512, 0.56),
                          ('icon-maskable-512.png', 512, 0.42), ('apple-touch-icon.png', 180, 0.56)]:
    write_png(os.path.join(out_dir, name), size, render(size, scale))
    print('wrote', name)
