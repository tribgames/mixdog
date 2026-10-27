# Regenerates the built-in skins' moving backgrounds (src/renderer/skins/<id>.webm)
# from their pictures (the <id>.jpg beside them, which stay the posters): the
# picture itself, untouched, with only drawn light and motion over it. Every
# motion runs a whole number of periods over the 12 s clip, so the last frame
# flows exactly into the first.
#
#   python apps/desktop/scripts/generate-skin-loops.py [id ...]
#
# Needs numpy, Pillow, and ffmpeg (with libvpx-vp9) on PATH. 1920x1080, 24 fps,
# VP9, no audio.
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SKINS = Path(__file__).resolve().parent.parent / "src" / "renderer" / "skins"
IDS = ["glass-flow", "night-city", "spring-window", "tech-studio"]
W, H, FPS, SECONDS = 1920, 1080, 24, 12
FRAMES = FPS * SECONDS
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
rows = np.arange(H)


def noise(cells, seed):
    """Smooth random field in [0, 1): low-res noise upsampled."""
    small = (
        np.random.default_rng(seed)
        .random((cells, int(cells * W / H) + 1))
        .astype(np.float32)
    )
    return (
        np.asarray(
            Image.fromarray((small * 255).astype(np.uint8)).resize(
                (W, H), Image.BICUBIC
            ),
            np.float32,
        )
        / 255
    )


def box(x0, y0, x1, y1, feather=40.0):
    """Soft rectangle mask."""
    fx = np.clip(np.minimum(xx - x0, x1 - xx) / feather, 0, 1)
    fy = np.clip(np.minimum(yy - y0, y1 - yy) / feather, 0, 1)
    return fx * fy


def sprite(radius):
    r = int(radius * 3) + 1
    gy, gx = np.mgrid[-r : r + 1, -r : r + 1].astype(np.float32)
    return np.exp(-(gx**2 + gy**2) / (2 * radius**2)), r


def star(size):
    r = size
    gy, gx = np.mgrid[-r : r + 1, -r : r + 1].astype(np.float32)
    core = np.exp(-(gx**2 + gy**2) / (2 * (size / 9) ** 2))
    rays = np.exp(-(gy**2) / 2.0) * np.exp(-np.abs(gx) / (size / 3)) + np.exp(
        -(gx**2) / 2.0
    ) * np.exp(-np.abs(gy) / (size / 3))
    return np.clip(core + 0.8 * rays, 0, 1.6), r


def add(frame, patch, r, x, y, color):
    x, y = int(round(x)), int(round(y))
    x0, x1, y0, y1 = max(0, x - r), min(W, x + r + 1), max(0, y - r), min(H, y + r + 1)
    if x0 >= x1 or y0 >= y1:
        return
    p = patch[y0 - (y - r) : y1 - (y - r), x0 - (x - r) : x1 - (x - r)]
    frame[y0:y1, x0:x1] += p[..., None] * color


def motes(rng, count, region, size, alpha):
    x0, y0, x1, y1 = region
    return [
        dict(
            x=rng.uniform(x0, x1),
            y=rng.uniform(y0, y1),
            ax=rng.uniform(15, 50),
            ay=rng.uniform(10, 40),
            px=rng.uniform(0, 6.3),
            py=rng.uniform(0, 6.3),
            k=int(rng.integers(1, 3)),
            tw=int(rng.integers(1, 4)),
            tp=rng.uniform(0, 6.3),
            a=rng.uniform(*alpha),
            s=sprite(rng.uniform(*size)),
        )
        for _ in range(count)
    ]


def draw_motes(over, items, t, color, floor):
    """Motes drift on closed loops and twinkle between `floor` and full."""
    for d in items:
        x = d["x"] + d["ax"] * math.sin(d["k"] * t + d["px"])
        y = d["y"] + d["ay"] * math.sin(d["k"] * t + d["py"])
        a = d["a"] * (floor + (1 - floor) * math.sin(d["tw"] * t + d["tp"]))
        add(over, d["s"][0], d["s"][1], x, y, color * a)


def flicker(mask, cycles, seed):
    """Per-area phase so neighbouring lights do not pulse together."""
    return mask, noise(18, seed) * 2 * math.pi, cycles


def render(skin):
    rng = np.random.default_rng(7 if skin == "glass-flow" else 11)
    base = (
        np.asarray(
            Image.open(SKINS / f"{skin}.jpg")
            .convert("RGB")
            .resize((W, H), Image.LANCZOS),
            np.float32,
        )
        / 255
    )
    luma = base @ np.array([0.299, 0.587, 0.114], np.float32)
    glows = []  # (mask[H,W], phase[H,W], cycles, amplitude)
    dust, dust_color, floor = [], np.array([1.0, 1.0, 1.0], np.float32), 0.5
    petals, glints = [], []
    ripple = band = flare = ghost = None
    tint = np.array([0.85, 0.9, 1.0], np.float32)

    if skin == "glass-flow":
        # A soft warm-white bloom in the bright upper-left corner, breathing;
        # dust motes; glints on the sphere rims and ribbon edges.
        flare = np.exp(-(((xx - 90) ** 2 + (yy - 60) ** 2) / (2 * 420.0**2)))[
            ..., None
        ] * np.array([1.0, 0.98, 1.0], np.float32)
        ghost = np.exp(-(((xx - 520) ** 2 + (yy - 300) ** 2) / (2 * 70.0**2)))[
            ..., None
        ] * np.array([0.75, 0.8, 1.0], np.float32)
        for _ in range(90):
            radius = rng.uniform(2.0, 5.0)
            dust.append(
                dict(
                    x=rng.uniform(0, W),
                    y=rng.uniform(0, H),
                    ax=rng.uniform(20, 70),
                    ay=rng.uniform(15, 55),
                    px=rng.uniform(0, 2 * math.pi),
                    py=rng.uniform(0, 2 * math.pi),
                    k=int(rng.integers(1, 3)),
                    tw=int(rng.integers(1, 4)),
                    tp=rng.uniform(0, 2 * math.pi),
                    a=rng.uniform(0.45, 0.95),
                    s=sprite(radius),
                )
            )
        floor = 0.55
        spots = [
            (1215, 128, 26, 0.0),
            (1352, 498, 40, 0.37),
            (1690, 748, 20, 0.62),
            (1360, 312, 16, 0.18),
            (1490, 128, 30, 0.81),
            (905, 845, 34, 0.5),
        ]
        glints = [(x, y, star(int(s * 2)), p) for x, y, s, p in spots]
    elif skin == "night-city":
        sky = yy < 560
        moon = ((xx - 1560) ** 2 + (yy - 165) ** 2) < 70**2
        stars = (luma > 0.45) & sky & ~moon
        glows.append((*flicker(stars.astype(np.float32), 3, 1), 0.9))
        warm = (
            (luma > 0.5) & (base[..., 0] > base[..., 2] + 0.08) & (yy > 560)
        ).astype(np.float32)
        glows.append((*flicker(warm, 2, 2), 0.35))
        # The river only: bluish pixels below the skyline, smoothed so the warm
        # reflections inside the water ride along; banks, houses and trees stay.
        blue = ((base[..., 2] - base[..., 0] > 0.04) & (yy > 690) & (xx > 600)).astype(
            np.float32
        )
        soft = (
            np.asarray(
                Image.fromarray((blue * 255).astype(np.uint8)).filter(
                    ImageFilter.GaussianBlur(14)
                ),
                np.float32,
            )
            / 255
        )
        ripple = dict(
            mask=np.clip((soft - 0.55) / 0.25, 0, 1), amp=2.0, wave=9.0, cycles=4
        )
    elif skin == "spring-window":
        wall = box(0, 0, 1420, 1080, 120)
        sun = np.clip((luma - 0.78) / 0.15, 0, 1) * wall
        glows.append((sun, noise(10, 3) * 2 * math.pi, 1, 0.10))
        dust = motes(rng, 55, (150, 80, 1350, 950), (1.5, 3.5), (0.35, 0.75))
        dust_color = np.array([1.0, 0.95, 0.85], np.float32)
        for _ in range(26):
            petals.append(
                dict(
                    x=rng.uniform(1100, 1900),
                    y=rng.uniform(0, H + 80),
                    sway=rng.uniform(20, 70),
                    sp=rng.uniform(0, 6.3),
                    passes=int(rng.integers(1, 3)),
                    size=rng.uniform(6, 11),
                    spin=int(rng.integers(2, 5)),
                    c=np.array(
                        [1.0, rng.uniform(0.72, 0.84), rng.uniform(0.8, 0.9)],
                        np.float32,
                    ),
                    a=rng.uniform(0.7, 0.95),
                )
            )
    elif skin == "tech-studio":
        sat = base.max(axis=2) - base.min(axis=2)
        screen_area = np.maximum(
            box(1195, 525, 1920, 830, 1), box(1280, 325, 1710, 575, 1)
        )
        led = ((luma > 0.45) & (sat > 0.25) & (base[..., 2] > 0.7)).astype(
            np.float32
        ) * (1 - screen_area)
        glows.append((led, noise(4, 4) * 2 * math.pi, 2, 0.35))
        screens = np.maximum(
            box(1215, 545, 1900, 800, 12), box(1300, 345, 1690, 555, 12)
        ) * np.clip((luma - 0.5) / 0.2, 0, 1)
        band = dict(mask=screens, cycles=2)
        dust = motes(rng, 45, (250, 480, 1200, 960), (1.5, 3.5), (0.3, 0.7))
        dust_color = np.array([0.95, 0.9, 1.0], np.float32)
    else:
        raise SystemExit(f"unknown skin {skin}")

    out = SKINS / f"{skin}.webm"
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{W}x{H}",
            "-r",
            str(FPS),
            "-i",
            "-",
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "32",
            "-row-mt",
            "1",
            "-deadline",
            "good",
            "-cpu-used",
            "2",
            "-pix_fmt",
            "yuv420p",
            str(out),
        ],
        stdin=subprocess.PIPE,
    )
    for n in range(FRAMES):
        t = 2 * math.pi * n / FRAMES
        frame = base.copy()
        if ripple:
            # Rows of the river slide sideways by a few pixels in a travelling wave.
            shift = ripple["amp"] * np.sin(
                2 * math.pi * rows / ripple["wave"] + ripple["cycles"] * t
            )
            cols = np.clip(np.round(xx + shift[:, None]).astype(np.int32), 0, W - 1)
            m = ripple["mask"][..., None]
            frame = frame * (1 - m) + base[rows[:, None], cols] * m
        gain = np.zeros((H, W), np.float32)
        for mask, phase, cycles, amp in glows:
            # Lights only brighten and settle back; they never dim below the picture.
            gain += mask * amp * (0.5 + 0.5 * np.sin(cycles * t + phase))
        if band:
            # A soft light band drifts across the screens.
            pos = (xx / W * 3 - band["cycles"] * n / FRAMES * 3) % 3
            gain += band["mask"] * 0.18 * np.exp(-((pos - 1.5) ** 2) / 0.08)
        frame = frame * (1 + gain[..., None])
        over = np.zeros_like(base)
        if flare is not None:
            pulse = 0.5 - 0.5 * math.cos(t)
            over += flare * (0.08 + 0.22 * pulse) + ghost * (0.18 * pulse)
        draw_motes(over, dust, t, dust_color, floor)
        for x, y, (patch, r), phase in glints:
            a = max(0.0, math.sin(2 * math.pi * (n / FRAMES * 2 + phase))) ** 3
            if a > 0.01:
                add(over, patch, r, x, y, tint * a)
        for p in petals:
            span = H + 120
            y = (p["y"] + p["passes"] * span * n / FRAMES) % span - 60
            x = p["x"] + p["sway"] * math.sin(t * p["passes"] + p["sp"] + y / 140)
            squash = 0.35 + 0.65 * abs(math.sin(p["spin"] * t + p["sp"]))
            r = int(p["size"] * 2) + 1
            gy, gx = np.mgrid[-r : r + 1, -r : r + 1].astype(np.float32)
            shape = (
                np.clip(
                    1.5 - ((gx / p["size"]) ** 2 + (gy / (p["size"] * squash)) ** 2),
                    0,
                    1,
                )
                * p["a"]
            )
            xi, yi = int(round(x)), int(round(y))
            x0, x1, y0, y1 = (
                max(0, xi - r),
                min(W, xi + r + 1),
                max(0, yi - r),
                min(H, yi + r + 1),
            )
            if x0 < x1 and y0 < y1:
                a = shape[y0 - (yi - r) : y1 - (yi - r), x0 - (xi - r) : x1 - (xi - r)][
                    ..., None
                ]
                frame[y0:y1, x0:x1] = frame[y0:y1, x0:x1] * (1 - a) + p["c"] * a
        frame = 1 - (1 - np.clip(frame, 0, 1)) * (1 - np.clip(over, 0, 1))
        proc.stdin.write((np.clip(frame, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit(f"ffmpeg failed for {skin}")
    print(f"{out} {out.stat().st_size / 1e6:.2f} MB")


for skin in sys.argv[1:] or IDS:
    render(skin)
