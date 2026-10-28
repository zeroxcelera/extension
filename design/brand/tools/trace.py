"""Trace the generated mascot into clean geometry: one outer path + elliptical eyes.

Writes geometry.json (normalized to a 0..1000 box around the bird) for export.py.
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
im = np.array(Image.open(src).convert("RGB")).astype(np.float32)
yellow = (im[:, :, 0] > 170) & (im[:, :, 1] > 150) & (im[:, :, 2] < 160)

# Upscale + blur + threshold: smooth edges without losing the tips.
SCALE = 4
m = cv2.resize(yellow.astype(np.float32), None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_LINEAR)
m = cv2.GaussianBlur(m, (0, 0), sigmaX=2.2 * SCALE)
mask = (m > 0.5).astype(np.uint8)

contours, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
hier = hier[0]
outer_i = max(range(len(contours)), key=lambda i: cv2.contourArea(contours[i]) if hier[i][3] == -1 else 0)
outer = contours[outer_i][:, 0, :].astype(np.float64)
holes = [contours[i] for i in range(len(contours)) if hier[i][3] == outer_i and cv2.contourArea(contours[i]) > 200]

x0, y0 = outer[:, 0].min(), outer[:, 1].min()
w, h = outer[:, 0].max() - x0, outer[:, 1].max() - y0
side = max(w, h)
ox, oy = x0 - (side - w) / 2, y0 - (side - h) / 2


def norm(p):
    return [round((p[0] - ox) / side * 1000, 2), round((p[1] - oy) / side * 1000, 2)]


simplified = cv2.approxPolyDP(outer.astype(np.float32).reshape(-1, 1, 2), 1.2 * SCALE, True)[:, 0, :]
eyes = []
for c in holes:
    (cx, cy), (ew, eh), ang = cv2.fitEllipse(c)
    eyes.append({"c": norm((cx, cy)), "rx": round(ew / 2 / side * 1000, 2), "ry": round(eh / 2 / side * 1000, 2), "angle": round(ang, 1)})

json.dump({"outer": [norm(p) for p in simplified], "eyes": eyes, "aspect": [round(w / side, 4), round(h / side, 4)]}, open(out, "w"))
print("points", len(simplified), "eyes", len(eyes), eyes)
