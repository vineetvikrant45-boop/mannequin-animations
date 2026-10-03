# Mannequin Playground

A single, self-contained 3D playground game for Android, built from the assets in this
repository: the playground, the mannequin and its **walk / run / jump** motion clips are
combined into one mobile game with on-screen touch controls.

<p align="center">
  <b>Download:</b> <a href="dist/MannequinPlayground.apk">dist/MannequinPlayground.apk</a>
  (0.85 MB, Android 5.0+) · install notes in <a href="dist/index.html">dist/index.html</a>
</p>

---

## The game

| | |
|---|---|
| **Movement** | Drag the on-screen joystick to walk; push it to the edge (or press **RUN**) to run |
| **Jumping** | **JUMP** button — hold for a slightly higher hop |
| **Camera** | Drag anywhere on the world to look around |
| **Goal** | Collect the 8 rings of the course as fast as you can; your best run is remembered |
| **Toys** | Grab and throw the playground balls, ride the seesaw and carousel, slide, climb |
| **Settings** (⚙) | Joystick and jump-button **size**, **opacity** and **placement** (tap *Move controls*, then drag both controls), handedness, run style, look sensitivity/inversion, quality preset, day–night slider, shadows, FPS counter, sound, haptics |

Performance is mobile-first: a `PerformanceGovernor` watches frame times and lowers the render
scale, shadows and particle counts when the device cannot keep up; the pixel budget is capped per
quality preset, and geometry/textures stay small (≈38 k triangles for the whole park).

## Repository layout

```
game/                 the game (three.js, esbuild bundling)
  index.html          page shell: canvas, joystick, jump button, HUD, settings panel
  style.css           mobile-first UI (safe areas, drag editor, glass panels)
  src/main.js         entry point
  src/game.js         app shell: loader, render loop, quality governor, ring course
  src/player.js       character controller + third-person camera
  src/ui.js           HUD + settings panel wiring
  src/core/           settings persistence, quality presets, touch input, audio
  src/world/          the playground (park props, colliders, day/night, sky)
  src/char/rig.js     Mixamo → mannequin retargeting + clip baking
  build.mjs           bundles everything into one www/index.html
tools/
  apk_build.py        builds and signs dist/MannequinPlayground.apk (no Android SDK needed)
  apk_verify.py       verifies the APK the way the platform does
  apk/                hand-written encoders: binary XML, dex, v1+v2 signing
  smoke.mjs           headless game-logic test
  verify-rig.mjs      headless animation/retarget test
original/             the untouched inputs (playground page, mannequin, walk/run/jump .glb)
dist/                 build output: the APK + the download page
```

## Build and test

```bash
cd game && npm install            # once: three + esbuild

node build.mjs                    # game/www/index.html (single file, models inlined)
node build.mjs --serve            # …and serve it on http://0.0.0.0:8080

node ../tools/smoke.mjs           # game logic: controller, collisions, animation weights
node ../tools/verify-rig.mjs --check   # retargeted clips: foot/hip heights, facing, swing

python3 tools/apk_build.py            # rebuild the web bundle + package + sign the APK
python3 tools/apk_verify.py           # 58 checks over the manifest, dex and both signatures
```

`tools/apk_verify.py` decodes the binary manifest with androguard, disassembles `MainActivity`
from `classes.dex`, walks the APK Signing Block the way
`android.util.apk.ApkSignatureSchemeV2Verifier` does (content digest, RSA signature, layout) and
re-verifies the JAR signature's PKCS#7 over `CERT.SF`. Builds are also cross-checked against
`apksigtool verify` when that tool is installed.

## Why the APK is built by hand

The build sandbox cannot reach `dl.google.com`, Maven Central or the Android SDK, so
`tools/apk_build.py` produces everything that `aapt2` + `d8` + `apksigner` normally would:

* `tools/apk/binary_xml.py` — the binary `AndroidManifest.xml` (string pool, resource-map chunk,
  start/end element chunks);
* `tools/apk/dex.py` — a small Dalvik writer + assembler for the ~20 instructions of
  `MainActivity` (a `WebView` pointed at the bundled page);
* `tools/apk/sign.py` — JAR signing (v1: `MANIFEST.MF`, `CERT.SF`, a hand-built PKCS#7
  `CERT.RSA`) and APK Signature Scheme v2 (content digest over 1 MiB chunks, signer block, a
  padding pair that aligns the block to 4096 bytes).

The signing key (`tools/apk/mannequin-release.pem`) is generated on first build, is reused after
that so upgrades install over the previous version, and is **not** committed.

## Install on a phone

1. Download `dist/MannequinPlayground.apk` (tap the link on the phone).
2. Open the file and allow "install unknown apps" for the browser or Files app when Android asks.
3. Install, launch, and hold the phone sideways (the game is landscape-only).
