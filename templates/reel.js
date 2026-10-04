// Minimal turbo-render reel. Every pixel must be a pure function of t.
const W = 1920, H = 1080, FPS = 60, DUR = 6;
const COL = { ink: '#0c0c0e', paper: '#f2eee6', hot: '#ff4b1f' };
const DISPLAY = '"Archivo Black", "Arial Black", sans-serif';

// ---- helpers (deterministic: never Math.random()/Date.now() inside draw)
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, t) => a + (b - a) * t;
const E = {
  oX: x => x >= 1 ? 1 : 1 - Math.pow(2, -10 * x),
  ioX: x => x <= 0 ? 0 : x >= 1 ? 1 : x < .5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2,
  back: (x, s = 1.8) => x <= 0 ? 0 : 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
};
const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// ---- scenes receive the target ctx; draw the FULL frame (background first)
function scene(ctx, t) {
  ctx.fillStyle = COL.ink; ctx.fillRect(0, 0, W, H);
  const r = 18 * E.back(prog(t, 0.1, 0.5), 2.6);
  const st = E.ioX(prog(t, 1.0, 1.4));
  ctx.fillStyle = COL.paper;
  ctx.beginPath(); ctx.roundRect(W / 2 - lerp(r, W, st), H / 2 - lerp(r, 3, st), lerp(2 * r, 2 * W, st), lerp(2 * r, 6, st), r); ctx.fill();
  const word = 'TURBO', size = 260;
  ctx.font = `${size}px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.fillStyle = COL.hot;
  const a = E.oX(prog(t, 1.4, 2.1));
  ctx.save(); ctx.beginPath(); ctx.rect(0, H / 2 - size * 0.4, W, size * 0.8); ctx.clip();
  ctx.fillText(word, W / 2, H / 2 + size * 0.36 + (1 - a) * size);
  ctx.restore();
}

window.REEL = {
  width: W, height: H, fps: FPS, duration: DUR,
  blur: { shutter: 0.5, max: 8 },          // 180° shutter; runtime adapts samples per frame to motion
  init: async () => {
    await document.fonts.load(`100px "Archivo Black"`);
    await document.fonts.ready;
    // precompute particle targets, textures, etc. here (deterministically)
  },
  draw: (ctx, t) => scene(ctx, t),
  post: (ctx, frame) => {                    // optional: grain / vignette once per output frame
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  },
};
