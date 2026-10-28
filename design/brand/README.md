# Celera brand assets

The mascot is a swift (_celer_, "fast"): yellow `#ffe066` on navy `#0d1220`.

| File                                                    | Use                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `celera-mark.svg`                                       | Master mark, transparent background                          |
| `celera-mark-mono.svg`                                  | One colour (`currentColor`), eyes cut out                    |
| `celera-icon.svg`                                       | App icon: mark on a navy rounded square                      |
| `celera-lockup-on-dark.svg` / `-on-light.svg`           | Mark + wordmark, for headers, README, slides                 |
| `favicon.ico`                                           | Website favicon (16 / 32 / 48)                               |
| `png/icon-{16…1024}.png`                                | Extension, Web Store (128), Apple touch (180), PWA (192/512) |
| `png/icon-maskable-512.png`                             | Android / PWA maskable icon (safe-zone padding)              |
| `png/og-1200x630.png`, `png/github-social-1280x640.png` | Link previews                                                |
| `png/lockup-on-dark.png`, `png/lockup-on-light.png`     | Wordmark images                                              |

`png/toolbar-{16,32,48,128}.png` are the extension icons (copied to `public/icon/`): no
background, the bird fills the box at 16 and 32 px like other wallet icons, and the 128 px
one keeps the Chrome Web Store's 16 px transparent margin. At 16 and 32 px the mark is
simplified (one enlarged eye) so it stays legible.

## Regenerating

`source/mascot-generated.webp` is the original artwork. To rebuild everything:

```sh
python design/brand/tools/trace.py design/brand/source/mascot-generated.webp geometry.json
python design/brand/tools/export.py geometry.json design/brand
```

Requires Python with Pillow, NumPy and OpenCV.
