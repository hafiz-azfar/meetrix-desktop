"""Draw the Meetrix orbital mark as a Windows icon."""
from pathlib import Path
from PIL import Image, ImageDraw

image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((30, 30, 482, 482), 125, fill="#b8f38c")
draw.ellipse((144, 144, 368, 368), outline="#182a1b", width=15)
draw.ellipse((229, 229, 283, 283), fill="#182a1b")
for x, y in [(176, 176), (337, 336)]:
    draw.ellipse((x - 24, y - 24, x + 24, y + 24), fill="#182a1b", outline="#b8f38c", width=8)
image.save(Path(__file__).resolve().parents[1] / "desktop" / "icon.ico",
           sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
