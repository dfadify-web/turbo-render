#!/usr/bin/env node
// Where does frame time go?  node profile.mjs <reel.html> [t1,t2,...]
// Per time: raster cost of one draw (flushed), 2D→GL upload, full blurred GL frame, readback.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const puppeteer = createRequire(path.join(HERE, 'package.json'))('puppeteer-core');

const REEL = path.resolve(process.argv[2]), ROOT = path.dirname(REEL);
const times = (process.argv[3] || '1,5,10,15,20').split(',').map(Number);
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream'); fs.createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p));
const flags = (process.argv[4] || '').split(' ').filter(Boolean);
const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', ...flags] });
const pg = await b.newPage();
await pg.goto(`http://127.0.0.1:${server.address().port}/${path.basename(REEL)}?probe=1`);
await pg.waitForFunction(() => window.TURBO, { timeout: 60000 });
const r = await pg.evaluate(times => {
  const { fps, W, H } = TURBO, R = window.REEL;
  const mk = o => { const c = document.createElement('canvas'); c.width = W; c.height = H; return [c, c.getContext('2d', o)]; };
  const [gc, g] = mk({}), [cc, c] = mk({ willReadFrequently: true });
  const glc = document.createElement('canvas'); glc.width = W; glc.height = H;
  const gl = glc.getContext('webgl2'); const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
  const px = new Uint8Array(4);
  const flushG = () => g.getImageData(0, 0, 1, 1);
  const time = (fn, n = 4) => { fn(); const s = performance.now(); for (let k = 0; k < n; k++) fn(); return +((performance.now() - s) / n).toFixed(1); };
  const rows = [];
  for (const t of times) {
    const i = Math.round(t * fps);
    rows.push({
      t,
      js_record: time(() => { g.save(); R.draw(g, t); g.restore(); }),
      gpu_draw: time(() => { g.save(); R.draw(g, t); g.restore(); flushG(); }),
      cpu_draw: time(() => { c.save(); R.draw(c, t); c.restore(); c.getImageData(0, 0, 1, 1); }),
      upload: time(() => { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, gc); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }),
      readback8MB: time(() => g.getImageData(0, 0, W, H), 2),
      gl_frame: time(() => { TURBO.frame(i); }, 2),
    });
  }
  return rows;
}, times);
console.log(`${await b.version()}  ${flags.join(' ')}`); console.table(r);
await b.close(); server.close();
