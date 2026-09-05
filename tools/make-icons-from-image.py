"""Turn a source artwork PNG into the extension's icon set.

    python tools/make-icons-from-image.py <source.png>

The source is trimmed to the artwork's own bounds (generated art usually sits on
a wide empty margin, which wastes most of a 16px icon), padded back to a square,
then resampled to each size Chrome asks for. The corners are rounded and made
transparent so the icon sits properly on any toolbar background.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageChops

SIZES = (16, 32, 48, 128)
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"


def crop_to_subject(im: Image.Image, min_saturation: int = 26) -> Image.Image:
    """
    Crop to the coloured subject rather than to the outer border.

    Generated app-icon art tends to nest the real subject inside a white card
    inside a grey backdrop. Trimming only the outer margin still leaves the
    subject occupying a fraction of the frame, which is illegible at 16px. So
    find the *saturated* pixels — the artwork itself — and crop to those.
    """
    hsv = im.convert("RGB").convert("HSV")
    saturation = hsv.getchannel("S")
    mask = saturation.point(lambda p: 255 if p > min_saturation else 0)
    box = mask.getbbox()
    if not box:
        return im

    # A little air around the subject so it does not touch the rounded corners.
    pad = round(max(box[2] - box[0], box[3] - box[1]) * 0.16)
    return im.crop((
        max(0, box[0] - pad),
        max(0, box[1] - pad),
        min(im.width, box[2] + pad),
        min(im.height, box[3] + pad),
    ))


def squarify(im: Image.Image, background=(255, 255, 255, 255)) -> Image.Image:
    """Centre the artwork on a square canvas so it is never distorted."""
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), background)
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas


def rounded(im: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, im.width - 1, im.height - 1),
        radius=int(min(im.size) * radius_ratio),
        fill=255,
    )
    out = im.copy()
    # Keep any transparency the artwork already had.
    existing = out.getchannel("A")
    out.putalpha(ImageChops.darker(existing, mask))
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    source = Path(sys.argv[1])
    if not source.is_absolute():
        source = ROOT / source
    if not source.exists():
        print(f"No such file: {source}")
        return 1

    art = squarify(crop_to_subject(Image.open(source).convert("RGBA")))
    OUT.mkdir(exist_ok=True)

    for size in SIZES:
        icon = rounded(art.resize((size, size), Image.LANCZOS))
        path = OUT / f"icon_{size}.png"
        icon.save(path, "PNG", optimize=True)
        print(f"icons/icon_{size}.png  {size}x{size}  {path.stat().st_size} bytes")

    print("\nReload the extension at chrome://extensions to see the new icon.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
