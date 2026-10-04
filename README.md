# turbo-render

**Fast, high-quality renderer for deterministic HTML canvas animations → MP4.**
GPU compositing, adaptive motion blur accumulated in float, hardware video encoding *inside* Chrome (WebCodecs), parallel workers, correct BT.709 color.

It ships as a [Claude Code](https://claude.com/claude-code) **skill** (Claude writes the animation and renders it for you), but it is also a plain Node CLI you can use on your own.

```
30 s vertical reel · 1080×1920 @ 60 fps · 6-sample motion blur
naive puppeteer + PNG + ffmpeg pipeline   8 min 18 s
turbo-render (final preset)               2 min 26 s   ← better image quality, too
simple scenes                             65 fps final · 110 fps draft (faster than real time)
```

---

## Why it's fast — measured bottlenecks and fixes

Every number below was measured, not guessed (Snapdragon X Plus laptop, Chrome 154).

| # | Bottleneck in the usual "screenshot every frame" pipeline | Measured | turbo-render |
|---|---|---|---|
| 1 | `toDataURL('png')` → base64 over CDP → PNG decode in ffmpeg | ~150 ms / frame | No PNG anywhere; binary transport |
| 2 | **Getting pixels out of a headless renderer** (fetch / CDP / WebSocket) | 9–25 MB/s (loopback Node↔Node: 376 MB/s) | **Encode inside Chrome with WebCodecs (hardware)** — only the compressed bitstream leaves the renderer. Raw path uses one persistent WebSocket (2.5× faster than `fetch`) and I420 (1.5 B/px instead of 4) |
| 3 | Uploading a `<canvas>` to WebGL (`texSubImage2D(canvas)`) | 15–20 ms per sample | `OffscreenCanvas.transferToImageBitmap()` hands the GPU surface over: ~0 ms |
| 4 | Motion blur via `drawImage` + `globalAlpha` in 8-bit | banding, slow on CPU | Accumulation in a **WebGL2 RGBA16F** target + TPDF dither |
| 5 | Fixed N blur samples even when nothing moves | N× work always | **Adaptive blur**: render shutter-open/close, measure change on the GPU (64×114 probe), pick 1…max samples; both endpoint samples are reused |
| 6 | CPU-backed canvases (`willReadFrequently`) | 300–600 ms / frame with blur | GPU canvases by default |
| 7 | ffmpeg's default BT.601 matrix for RGB→YUV (shifted colors in HD) | — | BT.709 limited-range conversion in a shader + proper color tags in the MP4 |
| 8 | Synchronous readback stalling the GPU | 10–70 ms | Triple PBOs + fence polled across tasks |
| 9 | One sequential process | — | N Chrome workers pulling frame chunks dynamically; chunks joined with `-c copy` (no re-encode) |
| 10 | x64 ffmpeg emulated on Windows ARM | ~2× slower | `setup.mjs` fetches a native ffmpeg build |
| 11 | x264 `medium`/`slow` as the final bottleneck | 10–18 fps | Final preset uses the hardware encoder; x264 `fast` ≈ `medium` SSIM (0.9953 vs 0.9954) |

**Quality** against a lossless reference of the hardest section (6 000 particles + film grain): hardware H.264 @ 140 Mbps → SSIM **0.9914**, x264 crf 14 → 0.9912.

---

## Install

Requirements: **Node ≥ 18**, **Google Chrome or Edge**, **ffmpeg** (fetched automatically on Windows).

### As a Claude Code skill

```bash
git clone https://github.com/dfadify-web/turbo-render ~/.claude/skills/turbo-render
cd ~/.claude/skills/turbo-render && node setup.mjs
```

Then just ask Claude for a motion graphics video ("make a 15 s intro for my brand", "render this animation to mp4"…) or type `/turbo-render`.

### Standalone CLI

```bash
git clone https://github.com/dfadify-web/turbo-render && cd turbo-render
node setup.mjs                 # deps + native ffmpeg if needed
node setup.mjs ../my-reel      # scaffold a project (runtime + template)
```

Set `CHROME_PATH` if Chrome/Edge isn't in a standard location.

---

## Usage

```bash
cd my-reel
# 1. review: PNG stills + contact sheet (stills/sheet.png) — seconds, not minutes
node ../turbo-render/render.mjs reel.html --stills 0.5,1.2,2.8,4

# 2. quick draft (half res, no blur)
node ../turbo-render/render.mjs reel.html --quality draft

# 3. final, with audio
node ../turbo-render/render.mjs reel.html --audio audio.wav --out video.mp4

# only a section while iterating
node ../turbo-render/render.mjs reel.html --from 7.6 --to 11
```

Live preview: open `reel.html` in a browser — `space` pause, `←/→` ±1 s, `,`/`.` ±1 frame, `b` toggle blur.

### Presets

| `--quality` | Resolution | Max blur samples | Encoder | For |
|---|---|---|---|---|
| `draft` | ×0.5 | 1 | hardware, 0.15 bpp | timing / rhythm checks |
| `final` *(default)* | ×1 | 6 (adaptive) | **hardware H.264** (WebCodecs), ~1.1 bpp capped at 140 Mbps | delivery |
| `master` | ×1 | 12 | x264 `slow` crf 12 (raw frames) | maximum quality, slower |

Overrides: `--blur N` `--scale X` `--mbps N` `--codec hevc` `--encoder hw|x264|null` `--crf N` `--preset P` `--workers N` `--engine 2d|gl` `--timing` `--cpu`.

If WebCodecs or the hardware encoder is unavailable it falls back to x264 automatically; without WebGL2 float targets, to a 2D compositing engine.

---

## The `window.REEL` contract

Your animation is a page that defines one object; the runtime does everything else.

```html
<canvas id="c"></canvas>
<script src="reel.js"></script>
<script src="reel-runtime.js"></script>
```

```js
window.REEL = {
  width: 1920, height: 1080, fps: 60, duration: 15,
  blur: { shutter: 0.5, max: 8 },        // 180° shutter · false = no blur
  init: async () => {                     // fonts, precomputation (deterministic)
    await document.fonts.load('100px "Archivo Black"');
  },
  draw: (ctx, t) => {                     // paint the WHOLE frame at time t (seconds)
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1920, 1080);
    // ...
  },
  post: (ctx, frame) => {},               // optional: grain / vignette, once per output frame
};
```

Rules:
- **`draw` must be a pure function of `t`.** No `Math.random()`, `Date.now()` or state that advances between calls — frames are rendered out of order, several times each (motion blur) and in different processes. Use a deterministic `hash(i)` for randomness; precompute simulations in `init`.
- Repaint everything (start with the background); always draw in `width × height` coordinates (the runtime handles scaling).
- Load fonts in `init` (and use `display=block`).
- Per-frame noise/grain goes in `post`, otherwise motion blur smears it.
- Avoid large `ctx.filter` blurs / `shadowBlur` at 1080p — they dominate frame time.

See [`templates/reel.js`](templates/reel.js) for a minimal working example.

---

## Profiling

```bash
node render.mjs reel.html --from 5 --to 7 --timing        # ms/frame per phase
node render.mjs reel.html --from 5 --to 7 --encoder null  # render only, no encoding
node profile.mjs reel.html 1,5,9,15                       # draw / upload / readback cost at given times
```

## Known issues

- Some hardware encoders (seen on Qualcomm) silently fall back to a low default bitrate above ~150 Mbps → `final` caps at 140 Mbps. Constant-QP (`quantizer`) mode is accepted but ignored by hardware.
- Best `--workers` for the hardware path is usually 2–3 (GPU and encoder are shared); for x264 ~cores/2.
- Background load (games, another Chrome using the GPU) makes timings vary a lot.

## Layout

```
render.mjs              orchestrator: local server, Chrome workers, WebSocket transport, ffmpeg, assembly
runtime/reel-runtime.js in-browser engine (preview · stills · GL/2D compositing · WebCodecs) — copied into projects
templates/              minimal reel.html + reel.js
profile.mjs             per-phase profiler
setup.mjs               deps + native ffmpeg + project scaffolding
SKILL.md                instructions Claude Code follows when using the skill
```

## License

MIT
