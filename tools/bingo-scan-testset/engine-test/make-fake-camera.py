"""Makes a .y4m video for Chrome's fake camera (--use-file-for-fake-video-capture) from one photo.

Usage: python make-fake-camera.py <photo> <out.y4m> <steady|moving|shaky>
  steady  the same picture every frame, with a little sensor noise (a camera held on a stand)
  moving  the picture slides sideways by 2.5% of the width every frame (a camera being waved around)
  shaky   a slow wobble of about 1.5% of the width (a hand-held camera that is not yet still)
The picture is the photo cut to 4:3 and shrunk to 640x480; Chrome plays the file in a loop at 10 frames per second.
"""
import sys
import numpy as np
from PIL import Image

photo, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]
W, H, FRAMES = 640, 480, 12

img = Image.open(photo).convert('RGB')
# Cut to 4:3 (width:height) around the middle, then shrink
target = W / H
w, h = img.size
if w / h > target:
    nw = int(h * target)
    img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
else:
    nh = int(w / target)
    img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
base = np.asarray(img.resize((W, H), Image.LANCZOS)).astype(np.float32)

rng = np.random.default_rng(7)
with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F10:1 Ip A1:1 C420jpeg\n'.encode())
    for k in range(FRAMES):
        frame = base
        if mode == 'moving':
            frame = np.roll(base, int(W * 0.025) * k, axis=1)
        elif mode == 'shaky':
            frame = np.roll(base, int(round(W * 0.015 * np.sin(k * 1.3))), axis=1)
        frame = np.clip(frame + rng.normal(0, 1.5, frame.shape), 0, 255).astype(np.uint8)
        ycc = Image.fromarray(frame, 'RGB').convert('YCbCr')
        y, cb, cr = [np.asarray(c) for c in ycc.split()]
        cb = np.asarray(Image.fromarray(cb).resize((W // 2, H // 2), Image.BILINEAR))
        cr = np.asarray(Image.fromarray(cr).resize((W // 2, H // 2), Image.BILINEAR))
        f.write(b'FRAME\n')
        f.write(y.tobytes() + cb.tobytes() + cr.tobytes())
print('wrote', out)
