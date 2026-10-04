#!/usr/bin/env node
// One-time setup: node deps + a NATIVE ffmpeg for this CPU (an emulated x64 ffmpeg on ARM is ~2x slower).
//   node setup.mjs            -> install deps, fetch native ffmpeg if the system one is missing/emulated
//   node setup.mjs <project>  -> also copy runtime + template into <project> (won't overwrite)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sh = (c, o = {}) => execSync(c, { stdio: 'inherit', cwd: HERE, ...o });

if (!fs.existsSync(path.join(HERE, 'node_modules', 'puppeteer-core')) || !fs.existsSync(path.join(HERE, 'node_modules', 'ws'))) sh('npm install --no-audit --no-fund');

const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const local = path.join(HERE, 'bin', exe);
const peArch = f => { try { const b = fs.readFileSync(f); const pe = b.readInt32LE(0x3c); return { 0xaa64: 'arm64', 0x8664: 'x64' }[b.readUInt16LE(pe + 4)] || '?'; } catch { return null; } };
if (!fs.existsSync(local)) {
  let sys = null; try { sys = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg').toString().split(/\r?\n/)[0].trim(); } catch { }
  const emulated = process.platform === 'win32' && os.arch() === 'arm64' && sys && peArch(sys) === 'x64';
  if (process.platform === 'win32' && (!sys || emulated)) {
    const flavor = os.arch() === 'arm64' ? 'winarm64' : 'win64';
    console.log(`fetching native ffmpeg (${flavor})${emulated ? ' — system ffmpeg is x64 under emulation' : ''}...`);
    fs.mkdirSync(path.join(HERE, 'bin'), { recursive: true });
    const zip = path.join(HERE, 'bin', 'ff.zip');
    sh(`curl -sL -o "${zip}" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${flavor}-gpl.zip`);
    sh(`tar -xf "${zip}" -C "${path.join(HERE, 'bin')}"`);
    const dir = fs.readdirSync(path.join(HERE, 'bin')).find(d => d.startsWith('ffmpeg-master'));
    for (const f of ['ffmpeg.exe', 'ffprobe.exe']) fs.renameSync(path.join(HERE, 'bin', dir, 'bin', f), path.join(HERE, 'bin', f));
    fs.rmSync(path.join(HERE, 'bin', dir), { recursive: true, force: true }); fs.rmSync(zip, { force: true });
  } else if (!sys) console.log('!! no ffmpeg found — install it (brew install ffmpeg / apt install ffmpeg)');
  else console.log(`using system ffmpeg: ${sys}`);
}
console.log('ffmpeg:', fs.existsSync(local) ? `${local} (${peArch(local) || 'native'})` : 'system');

const proj = process.argv[2];
if (proj) {
  fs.mkdirSync(proj, { recursive: true });
  for (const [src, dst] of [['runtime/reel-runtime.js', 'reel-runtime.js'], ['templates/reel.html', 'reel.html'], ['templates/reel.js', 'reel.js']]) {
    const to = path.join(proj, dst);
    if (fs.existsSync(to) && dst !== 'reel-runtime.js') { console.log(`keep  ${to}`); continue; }
    fs.copyFileSync(path.join(HERE, src), to); console.log(`write ${to}`);
  }
}
