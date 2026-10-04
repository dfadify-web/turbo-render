---
name: turbo-render
description: Renderiza animaciones / motion graphics hechas en canvas (HTML+JS) a MP4 muy rápido y con calidad alta — render en GPU, motion blur adaptativo con acumulación float, codificación hardware WebCodecs dentro de Chrome, workers en paralelo, BT.709 correcto. Úsala siempre que haya que crear o renderizar un vídeo programático (showreel, intro, motion graphics, kinetic typography, animación procedural, vídeo vertical para Reels/TikTok, lower thirds…), cuando un render con puppeteer + ffmpeg vaya lento, o cuando pidan "renderizar", "exportar a mp4" o "sacar el vídeo" de una animación canvas.
---

# turbo-render

Motor de render para animaciones canvas deterministas. Medido en un Snapdragon X Plus (8 núcleos, Adreno): reel vertical 1080×1920@60 de 30 s con motion blur de 6 muestras → **8 min 18 s con el pipeline ingenuo, 2 min 26 s con turbo-render** (y con mejor calidad de imagen). En tramos ligeros llega a 40+ fps.

Archivos de la skill (`~/.claude/skills/turbo-render/`):

| Archivo | Qué es |
|---|---|
| `render.mjs` | Orquestador: servidor local, workers Chrome, WebSocket, ffmpeg, ensamblado |
| `runtime/reel-runtime.js` | Motor en el navegador (preview, stills, render GL/2D, WebCodecs) — se copia al proyecto |
| `templates/reel.html`, `templates/reel.js` | Plantilla mínima del contrato `window.REEL` |
| `profile.mjs` | Perfilador: coste de dibujo / upload / readback por instante |
| `setup.mjs` | Instala dependencias y un ffmpeg **nativo** para la CPU (y opcionalmente monta un proyecto) |
| `bin/ffmpeg.exe` | ffmpeg nativo (ARM64 aquí). Se usa automáticamente si existe |

## Flujo de trabajo

1. **Montar proyecto** (copia runtime + plantilla sin pisar lo existente):
   `node ~/.claude/skills/turbo-render/setup.mjs <carpeta-proyecto>`
2. **Escribir la animación** en `reel.js` cumpliendo el contrato (abajo). Diseña escena a escena con tiempos locales.
3. **Revisar con stills + hoja de contactos** — es la forma más rápida de ver el vídeo entero sin renderizarlo:
   `node ~/.claude/skills/turbo-render/render.mjs reel.html --stills 0.5,1.2,2.8,4.0`
   → `stills/sheet.png`. Ábrela con Read, corrige y repite. Incluye siempre instantes de transición.
4. **Borrador rápido** (media resolución, sin blur): `--quality draft`
5. **Final**: `node ~/.claude/skills/turbo-render/render.mjs reel.html --audio audio.wav --out video.mp4`
6. Para iterar sobre una escena: `--from 7.6 --to 11` renderiza solo ese tramo.

Preview en tiempo real: abrir `reel.html` en el navegador (espacio = pausa, ←/→ = ±1 s, `,`/`.` = ±1 fotograma, `b` = blur).

## Contrato `window.REEL`

```js
window.REEL = {
  width: 1080, height: 1920, fps: 60, duration: 30,
  blur: { shutter: 0.5, max: 8 },   // 0.5 = obturador 180°. false = sin blur
  init: async () => { await document.fonts.load('100px "Archivo Black"'); /* precálculo */ },
  draw: (ctx, t) => { /* pinta el fotograma COMPLETO en t (s), coords width×height */ },
  post: (ctx, frame) => { /* opcional: grano, viñeta — una vez por fotograma de salida, sin blur */ },
};
```

Reglas (si se rompen, el render paralelo/blur sale mal):
- **`draw` es función pura de `t`**: nada de `Math.random()`, `Date.now()`, estado que avance entre llamadas ni acumuladores. Aleatoriedad → `hash(i)` determinista; simulaciones → fórmula cerrada o precalcular en `init`. El runtime llama a `draw` fuera de orden, varias veces por fotograma y en procesos distintos.
- **Repintar todo** cada vez (empezar con `fillRect` del fondo). No suponer el contenido previo del canvas.
- Usar el `ctx` recibido (si el código usa un `ctx` global, reasignarlo dentro de `draw`). El runtime ya aplica la escala; dibujar siempre en coordenadas `width×height`.
- Fuentes: `display=block` en el CSS y `document.fonts.load(...)` en `init`.
- Grano/ruido por fotograma → en `post` (usa `frame`), no en `draw`, o el blur lo emborronará.
- `ctx.filter` (blur CSS) y `shadowBlur` grandes son lentísimos a 1080p: evitar o usar con moderación.

## Presets

| `--quality` | Resolución | Blur máx. | Codificador | Uso |
|---|---|---|---|---|
| `draft` | ×0.5 | 1 | hardware, 0.15 bpp | revisar ritmo/tiempos en segundos |
| `final` (defecto) | ×1 | 6 (adaptativo, mín. 4 si hay movimiento) | **hardware WebCodecs H.264**, ~1.1 bpp con tope 140 Mbps | entrega |
| `master` | ×1 | 12 | x264 `slow` crf 12 (fotogramas en bruto) | máxima calidad, más lento |

Overrides: `--blur N`, `--scale X`, `--mbps N`, `--codec hevc`, `--encoder x264|hw|null`, `--crf N`, `--preset P`, `--workers N`, `--timing`.

## Por qué es rápido — cuellos de botella medidos y solución

| # | Cuello de botella (pipeline ingenuo) | Medido | Solución en turbo-render |
|---|---|---|---|
| 1 | `toDataURL('png')` + base64 por CDP + decodificar PNG en ffmpeg | ~150 ms/fotograma | Nada de PNG. Transporte binario |
| 2 | **Sacar píxeles del renderer de Chrome headless** (fetch/CDP/WebSocket) | 9–25 MB/s (!) — en loopback Node↔Node 376 MB/s | **Codificar dentro de Chrome con WebCodecs (hardware)**: solo sale el bitstream (~15 MB/s a 140 Mbps). Para x264: WebSocket persistente (2,5× más rápido que fetch) e I420 (1,5 B/px en vez de 4) |
| 3 | Subir un `<canvas>` 2D a WebGL (`texSubImage2D(canvasElement)`) | 15–20 ms por submuestra | `OffscreenCanvas.transferToImageBitmap()` → ~0 ms (cede la superficie GPU sin copia) |
| 4 | Motion blur con `drawImage` + `globalAlpha` en 8 bits | bandas + lento en CPU | Acumulación en **WebGL2 RGBA16F** + dither TPDF al cuantizar |
| 5 | Blur fijo de N muestras aunque no haya movimiento | N× trabajo siempre | **Blur adaptativo**: renderiza apertura y cierre del obturador, mide el cambio en GPU (64×114) y decide 1…max muestras; A y B se reutilizan |
| 6 | Canvas en CPU (`willReadFrequently`) | 300–600 ms/fotograma con blur | Canvas GPU por defecto (`--cpu` solo para depurar) |
| 7 | Conversión RGB→YUV en ffmpeg con matriz BT.601 por defecto (colores desplazados en HD) | — | Shader BT.709 rango limitado + etiquetas de color en el MP4 (`h264_metadata`) |
| 8 | Readback síncrono que congela la GPU | 10–70 ms | PBO ×3 + fence sondeado en tareas siguientes (solapa con el fotograma siguiente) |
| 9 | Un solo proceso secuencial | — | Workers Chrome en paralelo que **piden bloques dinámicamente** (las escenas pesadas no frenan al resto); bloques unidos con `-c copy` sin recodificar |
| 10 | ffmpeg x64 emulado en Windows ARM | ~2× más lento | `setup.mjs` descarga un ffmpeg nativo a `bin/` y `render.mjs` lo prefiere |
| 11 | x264 `medium`/`slow` como cuello final | 10–18 fps | Final usa hardware; x264 `fast` ≈ `medium` en SSIM (0,9953 vs 0,9954) con +30 % velocidad |

Calidad medida contra una referencia sin pérdidas del mismo tramo (partículas + grano, lo más difícil de comprimir): hardware H.264 a 140 Mbps → SSIM 0,9914; x264 crf 14 → 0,9912. Es decir, `final` iguala a x264 crf 14 siendo 5–10× más rápido.

## Problemas conocidos

- **Codificador hardware y bitrate**: en algunos drivers (Qualcomm aquí), por encima de ~150 Mbps el encoder ignora el bitrate y cae a un valor bajo por defecto (SSIM se desploma). Por eso `final` limita a 140 Mbps. El modo `quantizer` (QP constante) se acepta pero se ignora en hardware — no usarlo.
- Si WebCodecs/hardware no está disponible, el runtime cae solo a la ruta x264 (y si no hay WebGL2 con float, al motor 2D).
- Carga externa (juegos, otro Chrome usando GPU) hace variar mucho las cifras; para medir, cerrar lo pesado y usar `--timing` o `profile.mjs`.
- `--workers`: con hardware el óptimo suele ser 3 (GPU y encoder compartidos); más workers empeora. Con x264, ~núcleos/2.
- Audio: siempre aparte (WAV) y `--audio`; con `--from` se recorta solo al tramo.
- Atascos raros: hay watchdog (90 s sin fotogramas → aborta con error) y timeouts en el encoder. Si una página falla, el error del navegador sale en consola con `[page]`.

## Depurar rendimiento

```
node ~/.claude/skills/turbo-render/render.mjs reel.html --from 5 --to 7 --timing        # ms/fotograma por fase
node ~/.claude/skills/turbo-render/render.mjs reel.html --from 5 --to 7 --encoder null  # solo render, sin codificar
node ~/.claude/skills/turbo-render/profile.mjs reel.html 1,5,9,15                       # coste de draw/upload/readback por instante
```
Fases: `draw` (grabar comandos JS), `upload` (2D→GL), `probe` (espera GPU de A/B), `encode` (cola WebCodecs), `readFinish`/`sendWait` (ruta x264). Si `draw` domina → simplificar la escena (menos primitivas, menos texto por fotograma, cachear en `OffscreenCanvas`); si `sendWait` domina en x264 → usar `final` (hardware).
