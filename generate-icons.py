#!/usr/bin/env python3
"""Generate simple Discernment icons as PNGs using basic drawing."""
import struct
import zlib
import os

def create_png(width, height, pixels):
    """Create a minimal PNG from RGBA pixel data."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter: none
        for x in range(width):
            raw += bytes(pixels[y][x])

    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) +
        chunk(b'IDAT', zlib.compress(raw)) +
        chunk(b'IEND', b'')
    )

def draw_icon(size):
    """Draw a dark circle with a subtle inner dot — minimal, Apple-like."""
    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]
    cx, cy = size / 2, size / 2
    r_outer = size * 0.42
    r_inner = size * 0.12

    for y in range(size):
        for x in range(size):
            dx, dy = x - cx + 0.5, y - cy + 0.5
            dist = (dx**2 + dy**2) ** 0.5

            # Outer circle
            if dist <= r_outer:
                edge = max(0, min(1, (r_outer - dist)))
                alpha = int(min(edge, 1.0) * 255)
                pixels[y][x] = (26, 26, 26, alpha)  # #1a1a1a

            # Inner dot (taste indicator)
            if dist <= r_inner:
                edge = max(0, min(1, (r_inner - dist)))
                alpha = int(min(edge, 1.0) * 255)
                pixels[y][x] = (129, 140, 248, alpha)  # indigo #818cf8

    return pixels

icons_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(icons_dir, exist_ok=True)

for size in [16, 48, 128]:
    pixels = draw_icon(size)
    png_data = create_png(size, size, pixels)
    path = os.path.join(icons_dir, f"icon{size}.png")
    with open(path, 'wb') as f:
        f.write(png_data)
    print(f"Created {path}")
