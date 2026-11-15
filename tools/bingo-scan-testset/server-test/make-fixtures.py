# Makes the test images for server-test.js (needs Pillow). Usage: python make-fixtures.py <output folder>
import os
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def noisy(size, seed):
    # Random pixels do not compress, so the file size is predictable
    rnd = os.urandom(size[0] * size[1] * 3)
    return Image.frombytes('RGB', size, rnd)


# A believable sheet: 5x5 tiles of 72x80 with a number in each, small file
sheet = Image.new('RGB', (360, 400), 'white')
d = ImageDraw.Draw(sheet)
for r in range(5):
    for c in range(5):
        d.rectangle([c * 72 + 2, r * 80 + 2, c * 72 + 69, r * 80 + 77], outline=(120, 120, 140))
        d.text((c * 72 + 28, r * 80 + 34), str(r * 5 + c + 1), fill=(20, 20, 60))
sheet.save(os.path.join(out, 'sheet_ok.jpg'), quality=90)

Image.new('RGB', (300, 300), 'white').save(os.path.join(out, 'sheet_wrong_size.jpg'), quality=90)
noisy((360, 400), 1).save(os.path.join(out, 'sheet_big.jpg'), quality=100)          # over the 100 KB limit
Image.new('RGB', (360, 400), 'white').save(os.path.join(out, 'not_a_jpeg.png'))     # a PNG, not a JPEG

photo = Image.new('RGB', (900, 700), (200, 190, 170))
ImageDraw.Draw(photo).rectangle([100, 100, 800, 600], outline=(40, 40, 40), width=6)
photo = Image.blend(photo, noisy((900, 700), 2), 0.12)
photo.save(os.path.join(out, 'photo_ok.jpg'), quality=70)                           # under the 300 KB limit
noisy((1400, 1000), 3).save(os.path.join(out, 'photo_big.jpg'), quality=100)        # over the 300 KB limit

# A tiny sheet, so a photo just over its own 300 KB limit still fits inside the 450 KB request limit
Image.new('RGB', (360, 400), 'white').save(os.path.join(out, 'sheet_small.jpg'), quality=60)

# A photo a few KB over 300 KB: grow random-noise size until the JPEG lands in 305-330 KB
side = 420
while True:
    path = os.path.join(out, 'photo_over.jpg')
    noisy((side, side), 4).save(path, quality=85)
    size = os.path.getsize(path)
    if size >= 305 * 1024:
        break
    side += 10
assert size <= 330 * 1024, size

for name in sorted(os.listdir(out)):
    print(name.ljust(22), os.path.getsize(os.path.join(out, name)), 'bytes')
