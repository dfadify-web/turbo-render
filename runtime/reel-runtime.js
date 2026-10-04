// turbo-render runtime — include AFTER the script that defines window.REEL.
//
//   window.REEL = {
//     width, height, fps, duration,
//     init:  async () => {},              // optional: fonts, precompute (must be deterministic)
//     draw:  (ctx, t) => {},              // REQUIRED: paint the FULL frame at time t (seconds), W×H coords, pure function of t
//     post:  (ctx, frame, info) => {},    // optional: per-output-frame finishing (grain, vignette) — not motion-blurred
//     blur:  { shutter: 0.5, max: 8 },    // optional: shutter in frames (0.5 = 180°); max samples. false = off
//   };
//
// Opened normally  -> realtime preview player (space = pause, ←/→ = ±1s, ,/. = ±1 frame, b = blur).
// Opened by render.mjs -> pulls frame chunks from the host and streams frames back.
//
// Engine "gl" (default when WebGL2 + float render targets exist):
//   2D canvas (GPU) per sample → WebGL2 float16 accumulation (no 8-bit banding) → dither →
//   RGB→YUV420 BT.709 in a shader → async PBO readback (1.5 B/px instead of 4) → host.
// Engine "2d" (fallback / ?engine=2d): 8-bit canvas accumulation, RGBA readback.
(() => {
  const qs = new URLSearchParams(location.search);
  const MODE = qs.has('probe') ? 'probe' : qs.has('render') ? 'render' : qs.has('still') ? 'still' : 'preview';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ------------------------------------------------------------------ WebGL engine
  const yieldCh = new MessageChannel(); const yq = [];
  yieldCh.port1.onmessage = () => yq.shift()();
  const yieldTask = () => new Promise(r => { yq.push(r); yieldCh.port2.postMessage(0); }); // ~0 ms macrotask (setTimeout clamps to 4 ms)

  function makeGL(W, H) {
    if (W % 8 || H % 2) return null;
    const c = new OffscreenCanvas(W, H);
    const gl = c.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    const VS = `#version 300 es
      void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    const HEAD = `#version 300 es
      precision highp float; precision highp int; out vec4 o;
      float hash(vec2 p, float s){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + s) * 43758.5453); }\n`;
    const prog = fs => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, HEAD + fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
      return { p, u };
    };
    const ACC = prog(`uniform sampler2D src; uniform float w;
      void main(){ o = vec4(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb * w, w); }`);
    const RESOLVE = prog(`uniform sampler2D acc; uniform int H; uniform float seed;
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy);
        vec3 c = texelFetch(acc, ivec2(p.x, H - 1 - p.y), 0).rgb;
        float d = hash(gl_FragCoord.xy, seed) + hash(gl_FragCoord.yx, seed + 1.7) - 1.0;   // TPDF dither
        o = vec4(c + d / 255.0, 1.0); }`);
    const PROBE = prog(`uniform sampler2D a; uniform sampler2D b; uniform ivec2 S; uniform ivec2 P;
      void main(){ ivec2 q = ivec2(gl_FragCoord.xy); float ch = 0.0;
        for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) {
          ivec2 p = (q * S) / P + ivec2((i * S.x) / (P.x * 4), (j * S.y) / (P.y * 4));
          vec3 d = abs(texelFetch(a, p, 0).rgb - texelFetch(b, p, 0).rgb);
          if (d.r + d.g + d.b > 12.0 / 255.0) ch += 1.0;
        }
        o = vec4(ch / 16.0, 0.0, 0.0, 1.0); }`);
    // Packs I420 (Y plane, U plane, V plane) into RGBA8 texels: 4 bytes per texel, W/4 texels per row.
    const YUV = prog(`uniform sampler2D img; uniform int W; uniform int H; uniform float dith; uniform float seed;
      vec3 px(int x, int y){ return texelFetch(img, ivec2(x, y), 0).rgb; }
      const vec3 K = vec3(0.2126, 0.7152, 0.0722);
      void main(){
        int ox = int(gl_FragCoord.x), oy = int(gl_FragCoord.y);
        float r[4];
        if (oy < H) {
          for (int j = 0; j < 4; j++) r[j] = 16.0 + 219.0 * dot(px(4 * ox + j, oy), K);
        } else {
          int base = (oy - H) * W + 4 * ox, hw = W / 2, Q = hw * (H / 2);
          for (int j = 0; j < 4; j++) {
            int idx = base + j; bool isV = idx >= Q; if (isV) idx -= Q;
            int cx = idx % hw, cy = idx / hw;
            vec3 c = (px(2*cx, 2*cy) + px(2*cx+1, 2*cy) + px(2*cx, 2*cy+1) + px(2*cx+1, 2*cy+1)) * 0.25;
            float y = dot(c, K);
            r[j] = isV ? 128.0 + 224.0 * (c.r - y) / 1.5748 : 128.0 + 224.0 * (c.b - y) / 1.8556;
          }
        }
        vec4 v = vec4(r[0], r[1], r[2], r[3]);
        vec4 d = vec4(hash(gl_FragCoord.xy, seed), hash(gl_FragCoord.xy, seed + 1.1), hash(gl_FragCoord.xy, seed + 2.3), hash(gl_FragCoord.xy, seed + 3.7)) - 0.5;
        o = clamp(floor(v + 0.5 + d * dith), 0.0, 255.0) / 255.0; }`);

    const tex = (w, h, fmt, type, ifmt) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      return t;
    };
    const fbo = t => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; };
    const texA = tex(W, H, 0, 0, gl.RGBA8), texB = tex(W, H, 0, 0, gl.RGBA8), texS = tex(W, H, 0, 0, gl.RGBA8), texO = tex(W, H, 0, 0, gl.RGBA8);
    const texAcc = tex(W, H, 0, 0, gl.RGBA16F), fAcc = fbo(texAcc);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const PW = 64, PH = Math.max(2, Math.round(64 * H / W));
    const texP = tex(PW, PH, 0, 0, gl.RGBA8), fP = fbo(texP);
    const YW = W / 4, YH = H * 3 / 2;
    const texY = tex(YW, YH, 0, 0, gl.RGBA8), fY = fbo(texY);
    const pbos = [0, 1, 2].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b); gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 3 / 2, gl.STREAM_READ); return b; });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);

    // OffscreenCanvas.transferToImageBitmap hands the 2D GPU surface to GL without a copy
    // (an HTMLCanvasElement source costs ~15-20 ms per upload at 1080p — the single biggest bottleneck).
    const upload = (t, canvas, keep) => {
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (!keep && canvas.transferToImageBitmap) { const bm = canvas.transferToImageBitmap(); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bm); bm.close(); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    };
    const bindTex = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
    const tri = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    const probeBuf = new Uint8Array(PW * PH * 4);

    return {
      canvas: c,
      upload: (which, canvas, keep) => upload({ A: texA, B: texB, S: texS, O: texO }[which], canvas, keep),
      probe() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fP); gl.viewport(0, 0, PW, PH); gl.disable(gl.BLEND);
        gl.useProgram(PROBE.p); bindTex(0, texA); bindTex(1, texB);
        gl.uniform1i(PROBE.u.a, 0); gl.uniform1i(PROBE.u.b, 1); gl.uniform2i(PROBE.u.S, W, H); gl.uniform2i(PROBE.u.P, PW, PH);
        tri(); gl.readPixels(0, 0, PW, PH, gl.RGBA, gl.UNSIGNED_BYTE, probeBuf);
        let s = 0; for (let i = 0; i < probeBuf.length; i += 4) s += probeBuf[i];
        return s / 255 / (PW * PH);
      },
      clearAcc() { gl.bindFramebuffer(gl.FRAMEBUFFER, fAcc); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
      accumulate(which, w) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fAcc); gl.viewport(0, 0, W, H);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.blendEquation(gl.FUNC_ADD);
        gl.useProgram(ACC.p); bindTex(0, { A: texA, B: texB, S: texS }[which]); gl.uniform1i(ACC.u.src, 0); gl.uniform1f(ACC.u.w, w);
        tri(); gl.disable(gl.BLEND);
      },
      resolve(seed) { // accumulation → visible canvas (upright, dithered 8-bit) so 2D post / PNG can use it
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
        gl.useProgram(RESOLVE.p); bindTex(0, texAcc); gl.uniform1i(RESOLVE.u.acc, 0); gl.uniform1i(RESOLVE.u.H, H); gl.uniform1f(RESOLVE.u.seed, seed);
        tri();
      },
      yuv(fromPost, seed) { // writes I420 into texY, then async readback into a PBO
        gl.bindFramebuffer(gl.FRAMEBUFFER, fY); gl.viewport(0, 0, YW, YH);
        gl.useProgram(YUV.p); bindTex(0, fromPost ? texO : texAcc);
        gl.uniform1i(YUV.u.img, 0); gl.uniform1i(YUV.u.W, W); gl.uniform1i(YUV.u.H, H);
        gl.uniform1f(YUV.u.dith, fromPost ? 0 : 1); gl.uniform1f(YUV.u.seed, seed);
        tri();
      },
      readStart(slot) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fY);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbos[slot]);
        gl.readPixels(0, 0, YW, YH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
        return sync;
      },
      // poll the fence across tasks (never block): Chrome then serves getBufferSubData from its
      // readback shadow copy instead of stalling the GPU pipeline.
      async readFinish(slot, sync) {
        for (let k = 0; gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED && k < 2000; k++) await yieldTask();
        gl.deleteSync(sync);
        const outBuf = new Uint8Array(W * H * 3 / 2);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbos[slot]);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, outBuf);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        return outBuf;
      },
    };
  }

  async function boot() {
    const R = window.REEL;
    if (!R || typeof R.draw !== 'function') throw new Error('window.REEL.draw is not defined');
    if (R.init) await R.init();

    const scale = parseFloat(qs.get('scale') || '1');
    const W = Math.round(R.width * scale / 2) * 2, H = Math.round(R.height * scale / 2) * 2;
    const sx = W / R.width, sy = H / R.height;
    const fps = R.fps, dur = R.duration, total = Math.round(fps * dur);
    const blurOn = R.blur !== false;
    const shutter = (R.blur && R.blur.shutter) ?? 0.5;
    const blurMax = blurOn ? parseInt(qs.get('blur') ?? ((R.blur && R.blur.max) ?? 8), 10) : 1;
    const minMove = Math.min(blurMax, parseInt(qs.get('minblur') || '4', 10));
    const opts = qs.get('gpu') === '0' ? { willReadFrequently: true } : {};

    const mk = (w, h, o = opts) => { const c = MODE === 'preview' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h); return [c, c.getContext('2d', o)]; };
    let outC, out;
    if (MODE === 'preview') {
      outC = document.getElementById('c') || document.body.appendChild(document.createElement('canvas'));
      outC.width = W; outC.height = H; out = outC.getContext('2d');
    } else[outC, out] = mk(W, H);
    const [aC, a] = mk(W, H), [bC, b] = mk(W, H), [sC, s] = mk(W, H);

    const G = (MODE === 'render' || MODE === 'still') && qs.get('engine') !== '2d' ? makeGL(W, H) : null;
    const engine = G ? 'gl' : '2d';

    const drawAt = (c, t) => {
      c.save(); c.setTransform(sx, 0, 0, sy, 0, 0);
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
      R.draw(c, clamp(t, 0, dur - 1e-6));
      c.restore();
    };
    const runPost = i => { if (R.post) { out.save(); out.setTransform(sx, 0, 0, sy, 0, 0); R.post(out, i, { width: R.width, height: R.height, fps }); out.restore(); } };
    // per-phase timing (cheap; reported with ?timing / --timing)
    const TM = {};
    const tm = (name, since) => { const now = performance.now(); if (name) TM[name] = (TM[name] || 0) + now - since; return now; };
    const samplesFor = f => f < 0.0004 ? 1 : clamp(Math.ceil(minMove + f * 120), Math.min(minMove, blurMax), blurMax);

    // 2D probe (fallback engine): downscale on GPU, read back a tiny image
    const PW = 96, PH = Math.max(2, Math.round(96 * H / W));
    const [, p] = mk(PW, PH, {});
    const probe2d = () => {
      p.clearRect(0, 0, PW, PH); p.drawImage(aC, 0, 0, PW, PH); const da = p.getImageData(0, 0, PW, PH).data;
      p.clearRect(0, 0, PW, PH); p.drawImage(bC, 0, 0, PW, PH); const db = p.getImageData(0, 0, PW, PH).data;
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 12) changed++;
      return changed / (PW * PH);
    };

    // ---- 2D engine frame: result lands in `out` (8-bit)
    const frame2d = (i, maxS = blurMax) => {
      let n = 1;
      if (maxS > 1) {
        const tA = (i - shutter / 2) / fps, tB = (i + shutter / 2) / fps;
        drawAt(a, tA); drawAt(b, tB);
        n = Math.min(maxS, samplesFor(probe2d()));
        out.globalAlpha = 1; out.drawImage(aC, 0, 0);
        if (n > 1) {
          for (let k = 1; k < n - 1; k++) { drawAt(s, tA + (tB - tA) * k / (n - 1)); out.globalAlpha = 1 / (k + 1); out.drawImage(sC, 0, 0); }
          out.globalAlpha = 1 / n; out.drawImage(bC, 0, 0);
        }
        out.globalAlpha = 1;
      } else drawAt(out, i / fps);
      runPost(i);
      return n;
    };

    // ---- GL engine frame: float accumulation; yuv=true queues an I420 conversion, else final RGBA lands in `out`
    const frameGL = (i, yuv) => {
      let n = 1, t;
      G.clearAcc();
      if (blurMax > 1) {
        const tA = (i - shutter / 2) / fps, tB = (i + shutter / 2) / fps;
        t = tm(); drawAt(a, tA); drawAt(b, tB); t = tm('draw', t);
        G.upload('A', aC); G.upload('B', bC); t = tm('upload', t);
        n = samplesFor(G.probe()); t = tm('probe', t);
        if (n === 1) G.accumulate('A', 1);
        else {
          G.accumulate('A', 1 / n);
          for (let k = 1; k < n - 1; k++) {
            drawAt(s, tA + (tB - tA) * k / (n - 1)); t = tm('draw', t);
            G.upload('S', sC); G.accumulate('S', 1 / n); t = tm('upload', t);
          }
          G.accumulate('B', 1 / n);
        }
      } else { t = tm(); drawAt(s, i / fps); t = tm('draw', t); G.upload('S', sC); G.accumulate('S', 1); t = tm('upload', t); }
      const seed = (i * 0.6180339) % 1 * 100;
      if (R.post || !yuv) {
        G.resolve(seed);
        out.globalAlpha = 1; out.drawImage(G.canvas, 0, 0);
        runPost(i);
        if (yuv) { G.upload('O', outC); G.yuv(true, seed); }
      } else G.yuv(false, seed);
      tm('post+yuv', t);
      return n;
    };

    window.TURBO = { W, H, fps, total, engine, frame: (i, maxS) => G ? frameGL(i, false) : frame2d(i, maxS) };
    if (MODE === 'probe') return;

    if (MODE === 'preview') {
      let t0 = performance.now(), paused = false, pt = 0, blurPrev = false;
      addEventListener('keydown', e => {
        const now = (performance.now() - t0) / 1000;
        if (e.key === ' ') { paused = !paused; if (paused) pt = now % dur; else t0 = performance.now() - pt * 1000; }
        const jump = { ArrowRight: 1, ArrowLeft: -1, '.': 1 / fps, ',': -1 / fps }[e.key];
        if (jump) { pt = ((paused ? pt : now) + jump + dur) % dur; t0 = performance.now() - pt * 1000; }
        if (e.key === 'b') blurPrev = !blurPrev;
      });
      const loop = () => {
        const t = paused ? pt : ((performance.now() - t0) / 1000) % dur;
        frame2d(Math.floor(t * fps), blurPrev ? Math.min(blurMax, 4) : 1);
        requestAnimationFrame(loop);
      };
      loop();
      return;
    }

    const post = (url, body) => fetch(url, { method: 'POST', body }).then(r => { if (!r.ok) throw new Error(url + ' -> ' + r.status); return r; });
    const wid = qs.get('worker') || '0';

    if (MODE === 'still') {
      for (const ts of (qs.get('still') || '').split(',').filter(Boolean)) {
        window.TURBO.frame(Math.round(parseFloat(ts) * fps));
        const blob = outC.convertToBlob ? await outC.convertToBlob({ type: 'image/png' }) : await new Promise(r => outC.toBlob(r, 'image/png'));
        await post(`/still?t=${encodeURIComponent(ts)}`, blob);
      }
      await post(`/done?w=${wid}`);
      return;
    }

    // ---- transport: one persistent binary WebSocket per worker.
    // Header [u32 chunk][u32 type][u32 n] + payload.  type 0 = encoded data (hw), 1 = hw chunk end (+stats json),
    // 2 = raw frame (n = blur samples), 3 = raw chunk end.  Host acks every raw frame once it reached ffmpeg's stdin.
    // (fetch() uploads from a headless renderer are ~2.5x slower than a WebSocket for multi-MB frames.)
    const ws = new WebSocket(`ws://${location.host}/ws?w=${wid}`); ws.binaryType = 'arraybuffer';
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let acked = 0, ackWait = null;
    ws.onmessage = () => { acked++; if (ackWait) { const w = ackWait; ackWait = null; w(); } };
    const msg = (chunk, type, n, data) => {
      const len = data ? data.byteLength : 0, u = new Uint8Array(12 + len), dv = new DataView(u.buffer);
      dv.setUint32(0, chunk); dv.setUint32(4, type); dv.setUint32(8, n);
      if (data) u.set(data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data, data.byteOffset || 0, len), 12);
      ws.send(u);
    };
    const drained = () => new Promise(r => { const c = () => ws.bufferedAmount ? setTimeout(c, 5) : r(); c(); });

    // ---- hardware path: WebCodecs VideoEncoder fed straight from the GPU canvas.
    // Only compressed bitstream leaves the renderer (~10-17 MB/s instead of ~190 MB/s of raw pixels).
    let vcfg = null;
    if (qs.get('encoder') === 'hw' && 'VideoEncoder' in window) {
      const hevc = qs.get('codec') === 'hevc';
      vcfg = {
        codec: hevc ? 'hev1.1.6.L153.B0' : 'avc1.640033', width: W, height: H, framerate: fps,
        bitrate: parseFloat(qs.get('bitrate') || '40e6'), bitrateMode: 'variable', latencyMode: 'quality',
        hardwareAcceleration: 'prefer-hardware', ...(hevc ? { hevc: { format: 'annexb' } } : { avc: { format: 'annexb' } }),
      };
      if (!(await VideoEncoder.isConfigSupported(vcfg).catch(() => ({}))).supported) {
        vcfg.hardwareAcceleration = 'no-preference';
        if (!(await VideoEncoder.isConfigSupported(vcfg).catch(() => ({}))).supported) vcfg = null;
      }
    }
    if (vcfg) {
      let cur = -1, encErr = null;
      const enc = new VideoEncoder({
        output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); msg(cur, 0, 0, b); },
        error: e => { encErr = e; },
      });
      enc.configure(vcfg);
      const tag = `${engine}+webcodecs(${vcfg.hardwareAcceleration === 'prefer-hardware' ? 'hw' : 'sw'})`;
      for (;;) {
        const job = await (await post(`/next?w=${wid}&fmt=${vcfg.codec.startsWith('hev') ? 'hevc' : 'h264'}&engine=${tag}`)).json();
        if (job.done) break;
        cur = job.chunk; let samp = 0;
        for (let i = job.from; i < job.to; i++) {
          samp += G ? frameGL(i, false) : frame2d(i);
          const t = tm();
          if (enc.state !== 'configured') throw encErr || new Error('VideoEncoder closed (' + enc.state + ')');
          const vf = new VideoFrame(outC, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
          enc.encode(vf, { keyFrame: i === job.from }); vf.close();
          // a failing hardware encoder stops dequeuing silently — never wait forever
          for (let waited = 0; enc.encodeQueueSize > 2; waited += 250) {
            if (encErr) throw encErr;
            if (waited > 20000) throw new Error(`hardware encoder stalled (${vcfg.codec} @ ${vcfg.bitrate / 1e6} Mbps) — lower --mbps`);
            await Promise.race([new Promise(r => enc.addEventListener('dequeue', r, { once: true })), new Promise(r => setTimeout(r, 250))]);
          }
          while (ws.bufferedAmount > 24e6) await new Promise(r => setTimeout(r, 2));
          tm('encode', t);
          if (encErr) throw encErr;
        }
        await Promise.race([enc.flush(), new Promise((_, j) => setTimeout(() => j(encErr || new Error('hardware encoder flush timed out')), 30000))]);
        if (encErr) throw encErr;
        msg(cur, 1, 0, new TextEncoder().encode(JSON.stringify({ samples: samp })));
      }
    } else {
      // ---- raw path (x264 on the host): I420 from the shader (GL) or RGBA (2D fallback)
      const fmt = G ? 'yuv420p' : 'rgba';
      let sent = 0;
      const send = async (c, n, buf) => {
        msg(c, 2, n, buf); sent++;
        const t = tm();
        while (sent - acked > 3) await new Promise(r => (ackWait = r));
        tm('sendWait', t);
      };
      for (;;) {
        const job = await (await post(`/next?w=${wid}&fmt=${fmt}&engine=${engine}`)).json();
        if (job.done) break;
        let pend = null;
        for (let i = job.from; i < job.to; i++) {
          if (G) {
            const n = frameGL(i, true);
            let t = tm();
            const slot = i % 3, sync = G.readStart(slot); t = tm('readStart', t);
            // collect the previous frame while the GPU works on this one
            if (pend) { const buf = await G.readFinish(pend.slot, pend.sync); tm('readFinish', t); await send(job.chunk, pend.n, buf); }
            pend = { n, slot, sync };
          } else {
            const n = frame2d(i);
            await send(job.chunk, n, out.getImageData(0, 0, W, H).data);
          }
        }
        if (pend) await send(job.chunk, pend.n, await G.readFinish(pend.slot, pend.sync));
        msg(job.chunk, 3, 0);
      }
    }
    await drained();
    await post(`/done?w=${wid}`, JSON.stringify(TM));
    ws.close();
  }

  boot().catch(e => {
    console.error(e);
    if (MODE !== 'preview') fetch('/error', { method: 'POST', body: String(e && e.stack || e) });
  });
})();
