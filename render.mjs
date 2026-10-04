#!/usr/bin/env node
// turbo-render — fast, high-quality renderer for deterministic canvas animations (window.REEL contract).
//
//   node render.mjs <reel.html> [options]
//     --out file.mp4          output (default: <reel>.mp4)
//     --audio file.wav        mux this audio track
//     --quality draft|final|master   (default final)
//     --encoder hw|x264|null  hw = WebCodecs hardware encoder inside Chrome (default for draft/final)
//                             x264 = raw frames → native x264 (default for master); null = render benchmark
//     --codec avc|hevc        hw codec (default avc = H.264, max compatibility)
//     --mbps N                hw bitrate (default from preset, scaled by resolution × fps)
//     --workers N             parallel Chrome renderers (default: auto)
//     --from S --to S         render only this time range (seconds)
//     --scale X  --blur N  --crf N  --preset P   overrides
//     --engine 2d|gl          browser compositing engine (default gl, auto-fallback 2d)
//     --cpu                   no GPU at all (debug)
//     --timing                print per-phase ms/frame
//     --stills 1.2,3.4,...    PNG stills + contact sheet instead of video
//     --sheet out.png         contact sheet path for --stills
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'package.json'));
const puppeteer = require('puppeteer-core');
const { WebSocketServer } = require('ws');

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; opt[k] = v; }
  else opt._.push(a);
}
if (!opt._[0]) { console.error('usage: node render.mjs <reel.html> [--out x.mp4] [--audio a.wav] [--quality draft|final|master] [--stills t1,t2]'); process.exit(1); }

const REEL = path.resolve(opt._[0]);
const ROOT = path.dirname(REEL);
// bpp = bits per pixel per frame for the hardware encoder (0.30 ≈ 37 Mbps at 1080×1920@60)
const PRESETS = {
  draft: { scale: 0.5, blur: 1, minblur: 1, encoder: 'hw', bpp: 0.15, crf: 23, preset: 'veryfast' },
  // hw encoders on some GPUs misbehave above ~150 Mbps (silently fall back to a low default) → capped at 140
  final: { scale: 1, blur: 6, minblur: 4, encoder: 'hw', bpp: 1.1, crf: 16, preset: 'fast' },
  master: { scale: 1, blur: 12, minblur: 6, encoder: 'x264', bpp: 0.8, crf: 12, preset: 'slow' },
};
const QNAME = opt.quality || 'final';
const Q = { ...PRESETS[QNAME] };
for (const k of ['scale', 'blur', 'crf']) if (opt[k] !== undefined) Q[k] = parseFloat(opt[k]);
if (opt.preset) Q.preset = opt.preset;
if (opt.encoder) Q.encoder = opt.encoder;
const CORES = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const OUT = path.resolve(opt.out || REEL.replace(/\.html?$/i, '') + '.mp4');
// native ffmpeg shipped with the skill (e.g. ARM64 build on Snapdragon) beats an emulated system one ~2×
const FFMPEG = [path.join(HERE, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')].find(fs.existsSync) || 'ffmpeg';

function findChrome() {
  const c = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const f = c.find(p => p && fs.existsSync(p));
  if (!f) throw new Error('Chrome/Edge not found — set CHROME_PATH');
  return f;
}

// ---------- state ----------
let meta = null;
const chunks = [];
let queue = [];
let doneWorkers = 0, failed = null, framesDone = 0, samples = 0, ENGINE = '?', STREAM = 'mp4';
const TIMING = {};
const stills = [];
let allDone; const allDoneP = new Promise(r => (allDone = r));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-'));
let WORKERS = 1, WORKERS_ACTIVE = 1;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };

// raw path: one x264 process per chunk, fed I420 (or RGBA fallback) over stdin
function spawnEncoder(ch, fmt) {
  const { W, H, fps } = meta;
  const threads = Math.max(2, Math.ceil(CORES * 1.5 / WORKERS));
  ch.file = path.join(TMP, `seg_${String(ch.idx).padStart(5, '0')}.mp4`);
  ch.ff = spawn(FFMPEG, ['-y', '-loglevel', 'error',
    ...(fmt === 'yuv420p'
      // browser already produced BT.709 limited-range I420 in a shader: zero conversion here
      ? ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-']
      // RGBA fallback: BT.709 matrix + accurate rounding (swscale would default to BT.601)
      : ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+bitexact']),
    ...(Q.encoder === 'null' ? ['-f', 'null', '-'] : [
      '-c:v', 'libx264', '-preset', Q.preset, '-crf', String(Q.crf), '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-g', String(fps * 2), '-threads', String(threads), '-an', ch.file])], { stdio: ['pipe', 'ignore', 'inherit'] });
  ch.closed = once(ch.ff, 'close');
}

async function pump(ch) {
  if (ch.pumping) return; ch.pumping = true;
  while (ch.pending.has(ch.next)) {
    const { buf, res } = ch.pending.get(ch.next); ch.pending.delete(ch.next); ch.next++;
    if (!ch.ff.stdin.write(buf)) await once(ch.ff.stdin, 'drain');
    framesDone++;
    res.end('ok');
  }
  ch.pumping = false;
}

const readBody = req => new Promise((res, rej) => { const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => res(Buffer.concat(parts))); req.on('error', rej); });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      switch (u.pathname) {
        case '/next': {
          const c = queue.shift();
          if (c === undefined) return res.end('{"done":true}');
          const ch = chunks[c], fmt = u.searchParams.get('fmt');
          ENGINE = u.searchParams.get('engine');
          if (fmt === 'h264' || fmt === 'hevc') { // hardware path: bitstream arrives over the WebSocket
            STREAM = fmt;
            ch.file = path.join(TMP, `seg_${String(ch.idx).padStart(5, '0')}.${fmt}`);
            ch.ws = fs.createWriteStream(ch.file); ch.closed = once(ch.ws, 'close');
          } else spawnEncoder(ch, fmt);
          return res.end(JSON.stringify({ chunk: c, from: ch.from, to: ch.to }));
        }
        case '/frame': {
          const ch = chunks[+u.searchParams.get('c')];
          samples += +u.searchParams.get('n');
          ch.pending.set(+u.searchParams.get('i'), { buf: body, res });
          return pump(ch);
        }
        case '/chunkdone': {
          const ch = chunks[+u.searchParams.get('c')];
          ch.ff.stdin.end(); await ch.closed; ch.done = true;
          return res.end('ok');
        }
        case '/still': {
          const t = u.searchParams.get('t'), f = path.join(ROOT, 'stills', `t${String(Math.round(parseFloat(t) * 1000)).padStart(7, '0')}.png`); // numeric sort
          fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); stills.push(f);
          return res.end('ok');
        }
        case '/done': {
          if (body.length) try { const t = JSON.parse(body); for (const k in t) TIMING[k] = (TIMING[k] || 0) + t[k]; } catch { }
          if (++doneWorkers >= WORKERS_ACTIVE) allDone();
          return res.end('ok');
        }
        case '/error': failed = body.toString(); console.error('\n[page error]\n' + failed); allDone(); return res.end('ok');
      }
      res.statusCode = 404; return res.end();
    }
    const fp = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { failed = String(e.stack || e); res.statusCode = 500; res.end(); allDone(); }
});
server.keepAliveTimeout = 60000;

// frame transport: [u32 chunk][u32 type][u32 n][payload]
//   0 = hw encoded data (≈1 frame)  1 = hw chunk end (+stats json)  2 = raw frame (n = blur samples)  3 = raw chunk end
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 28, perMessageDeflate: false });
wss.on('connection', sock => sock.on('message', async data => {
  const c = data.readUInt32BE(0), type = data.readUInt32BE(4), n = data.readUInt32BE(8), ch = chunks[c], body = data.subarray(12);
  try {
    if (type === 0) { ch.ws.write(body); framesDone++; }
    else if (type === 1) { try { samples += JSON.parse(body.toString()).samples; } catch { } ch.ws.end(); await ch.closed; ch.done = true; }
    else if (type === 2) {
      samples += n; framesDone++;
      if (!ch.ff.stdin.write(body)) await once(ch.ff.stdin, 'drain');
      sock.send('k');                              // ack → renderer may send the next frame
    } else if (type === 3) { ch.ff.stdin.end(); await ch.closed; ch.done = true; }
  } catch (e) { failed = String(e.stack || e); allDone(); }
}));

// ---------- main ----------
const t0 = Date.now();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/${path.basename(REEL)}`;
const chrome = findChrome();
const launch = () => puppeteer.launch({
  executablePath: chrome, headless: true, pipe: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,UseEcoQoSForBackgroundProcess', '--mute-audio', '--no-first-run',
    ...(opt.cpu ? ['--disable-gpu'] : ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'])],
});
const pageQS = extra => `?scale=${Q.scale}&blur=${Q.blur}&minblur=${Q.minblur}${opt.cpu ? '&gpu=0&engine=2d' : ''}${opt.engine ? '&engine=' + opt.engine : ''}${extra}`;

// probe the reel for size/fps/duration
const b0 = await launch();
const pg0 = await b0.newPage();
pg0.on('pageerror', e => console.error('[page]', e.message));
await pg0.goto(base + `?probe=1&scale=${Q.scale}`, { waitUntil: 'load' });
await pg0.waitForFunction(() => window.TURBO, { timeout: 60000 });
meta = await pg0.evaluate(() => ({ W: TURBO.W, H: TURBO.H, fps: TURBO.fps, total: TURBO.total }));
await b0.close();

if (opt.stills) {
  const b = await launch(); const pg = await b.newPage();
  pg.on('pageerror', e => console.error('[page]', e.message));
  await pg.goto(base + pageQS(`&still=${encodeURIComponent(opt.stills)}`));
  await allDoneP; await b.close(); server.close();
  if (failed) process.exit(1);
  stills.sort();
  const n = stills.length, landscape = meta.W >= meta.H;
  const tw = landscape ? 640 : 270, th = Math.round(tw * meta.H / meta.W);
  const cols = Math.max(1, Math.min(n, landscape ? 3 : 9));
  const sheet = path.resolve(opt.sheet || path.join(ROOT, 'stills', 'sheet.png'));
  const inputs = stills.flatMap(f => ['-i', f]);
  const fc = stills.map((_, i) => `[${i}:v]scale=${tw}:${th}[v${i}]`).join(';') + ';' +
    stills.map((_, i) => `[v${i}]`).join('') + `xstack=inputs=${n}:layout=` +
    stills.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`).join('|') + ':fill=black';
  if (n > 1) await once(spawn(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', fc, sheet], { stdio: 'inherit' }), 'close');
  console.log(`${n} stills -> ${path.join(ROOT, 'stills')}${n > 1 ? `\nsheet -> ${sheet}` : ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}

// hw: GPU + hardware encoder are shared → few workers; x264: CPU-bound encode → more workers
WORKERS = parseInt(opt.workers || (Q.encoder === 'hw' ? 3 : Math.max(1, Math.min(6, Math.floor(CORES / 2)))), 10);
const f0 = Math.round(parseFloat(opt.from || 0) * meta.fps);
const f1 = Math.min(meta.total, Math.round(parseFloat(opt.to || meta.total / meta.fps) * meta.fps));
const span = f1 - f0;
const CH = Math.max(meta.fps, Math.ceil(span / (WORKERS * 4)));
for (let s = f0, idx = 0; s < f1; s += CH, idx++) chunks.push({ idx, from: s, to: Math.min(f1, s + CH), next: s, pending: new Map() });
queue = chunks.map((_, i) => i);
WORKERS_ACTIVE = Math.min(WORKERS, chunks.length);
const mbps = parseFloat(opt.mbps || Math.min(140, Math.round(meta.W * meta.H * meta.fps * Q.bpp / 1e6)));

console.log(`turbo-render  ${meta.W}x${meta.H} @${meta.fps}  frames ${f0}-${f1}  quality=${QNAME}  blur≤${Q.blur}  encoder=${Q.encoder}${Q.encoder === 'hw' ? ` (${opt.codec || 'avc'} ${mbps} Mbps)` : Q.encoder === 'x264' ? ` (crf ${Q.crf} ${Q.preset})` : ''}  workers=${WORKERS_ACTIVE}  chunks=${chunks.length}`);
const encQS = Q.encoder === 'hw' ? `&encoder=hw&bitrate=${mbps * 1e6}${opt.codec ? '&codec=' + opt.codec : ''}` : '';
const browsers = await Promise.all(Array.from({ length: WORKERS_ACTIVE }, launch));
await Promise.all(browsers.map(async (b, w) => {
  const pg = await b.newPage();
  pg.on('pageerror', e => console.error('[page]', e.message));
  pg.on('console', m => { if ((m.type() === 'error' || m.type() === 'warn') && !/Failed to load resource|READ-usage buffer/.test(m.text())) console.error(`\n[page ${w} ${m.type()}]`, m.text().slice(0, 300)); });
  await pg.goto(base + pageQS(`&render=1&worker=${w}${encQS}`));
}));
const tStart = Date.now();
let lastProgress = Date.now(), lastFrames = 0;
const tick = setInterval(() => {
  const s = (Date.now() - tStart) / 1000;
  if (framesDone !== lastFrames) { lastFrames = framesDone; lastProgress = Date.now(); }
  else if (Date.now() - lastProgress > 90000) { failed = 'watchdog: no frames for 90 s (page hung?)'; console.error('\n' + failed); allDone(); }
  process.stdout.write(`\r  [${ENGINE}] ${framesDone}/${span} frames  ${(framesDone / s).toFixed(1)} fps  ${s.toFixed(0)}s   `);
}, 1000);
await allDoneP;
clearInterval(tick);
if (opt.timing) { console.log('\n  per-frame ms (summed over workers):'); for (const k in TIMING) console.log(`    ${k.padEnd(12)} ${(TIMING[k] / span).toFixed(1)}`); }
await Promise.all(browsers.map(b => b.close()));
await Promise.all(chunks.map(c => c.closed));
server.close();
if (failed) process.exit(1);
const renderS = (Date.now() - tStart) / 1000;
if (Q.encoder === 'null') { console.log(`\nrender-only: ${span} frames in ${renderS.toFixed(1)}s (${(span / renderS).toFixed(1)} fps, avg ${(samples / span).toFixed(2)} samples, ${ENGINE})`); process.exit(0); }

// assemble: lossless join (-c copy), tag BT.709, mux audio
const audio = opt.audio ? ['-ss', String(f0 / meta.fps), '-i', path.resolve(opt.audio)] : [];
// explicit -t instead of -shortest: raw Annex-B video has no timestamps and -shortest would drop the audio
const amap = opt.audio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '320k', '-t', String(span / meta.fps)] : [];
let input;
if (STREAM === 'h264' || STREAM === 'hevc') {
  const all = path.join(TMP, `all.${STREAM}`), w = fs.createWriteStream(all);
  for (const c of chunks) { w.write(fs.readFileSync(c.file)); }
  w.end(); await once(w, 'close');
  input = ['-fflags', '+genpts', '-f', STREAM, '-framerate', String(meta.fps), '-i', all];
  amap.unshift('-bsf:v', `${STREAM}_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0`);
} else {
  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, chunks.map(c => `file '${c.file.replace(/\\/g, '/')}'`).join('\n'));
  input = ['-f', 'concat', '-safe', '0', '-i', list];
}
const muxArgs = ['-y', '-loglevel', 'error', ...input, ...audio, '-map', '0:v', ...amap,
  '-c:v', 'copy', ...(STREAM === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', OUT];
if (process.env.TURBO_DEBUG) console.log('\n' + FFMPEG + ' ' + muxArgs.join(' '));
await once(spawn(FFMPEG, muxArgs, { stdio: 'inherit' }), 'close');
fs.rmSync(TMP, { recursive: true, force: true });
const el = (Date.now() - t0) / 1000;
console.log(`\ndone -> ${OUT}\n  ${span} frames: render+encode ${renderS.toFixed(1)}s (${(span / renderS).toFixed(1)} fps), total ${el.toFixed(1)}s, avg ${(samples / span).toFixed(2)} blur samples/frame, ${ENGINE}`);
