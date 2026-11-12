"""Icon source prep: flood-fill the connected black corner background to full transparency;
recover edge-pixel alpha by un-compositing against black."""
from collections import deque
from pathlib import Path

from PIL import Image

SRC = Path(__file__).resolve().parent.parent / "vibe_images" / "inline-translator-icon.png"
BG_MAX = 48  # black-background threshold on max channel (connectivity keeps it to the outer region)


def main():
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque()
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        q.append(seed)
        seen[seed[1] * w + seed[0]] = 1
    mask = set()
    while q:
        x, y = q.popleft()
        r, g, b, _ = px[x, y]
        if max(r, g, b) > BG_MAX:
            continue
        mask.add((x, y))
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                seen[ny * w + nx] = 1
                q.append((nx, ny))
    for x, y in mask:
        px[x, y] = (0, 0, 0, 0)
    # Edge ring: observed = foreground × alpha (composited over black); recover both to kill the dark halo
    fringe = set()
    for x, y in mask:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in mask:
                    fringe.add((nx, ny))
    for x, y in fringe:
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        na = min(255, max(r, g, b) * 255 // 160)
        if na <= 0:
            px[x, y] = (0, 0, 0, 0)
            continue
        px[x, y] = (min(255, r * 255 // na), min(255, g * 255 // na), min(255, b * 255 // na), na)
    im.save(SRC)
    print("transparent corners:", len(mask), "fringe:", len(fringe))


if __name__ == "__main__":
    main()