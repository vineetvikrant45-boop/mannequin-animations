#!/usr/bin/env node
/**
 * Build the game into game/www (the folder that gets packaged into the APK).
 *
 *   node build.mjs             production bundle (minified, inline assets)
 *   node build.mjs --dev       unminified + sourcemaps
 *   node build.mjs --watch     rebuild on change
 *   node build.mjs --serve     serve www/ on http://0.0.0.0:8080 for testing
 *
 * Everything (JS, CSS, glTF models) is inlined into a single index.html so the
 * packaged app has zero network dependencies and nothing to fetch at runtime.
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const WWW = path.join(ROOT, 'www');
const ASSETS = path.join(ROOT, 'assets');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const inline = args.includes('--inline');
const watch = args.includes('--watch');
const serve = args.includes('--serve');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.json': 'application/json'
};

/** Single-file build: glTF models are embedded as base64 data URIs. */
function inlineAssets(html) {
  return html.replace(/\{GLB:(mannequin|walk|run|jump)\}/g, (_m, name) =>
    'data:model/gltf-binary;base64,' + fs.readFileSync(path.join(ASSETS, name + '.glb')).toString('base64'));
}

function writeIndex(js, css, outfile) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
  html = html.replace('<script type="module" src="main.js"></script>', `<script type="module">\n${js}\n</script>`);
  if (inline) html = inlineAssets(html);
  fs.mkdirSync(WWW, { recursive: true });
  fs.writeFileSync(outfile, html);

  // also emit a small assets folder for the dev server path (not used in the APK)
  const devAssets = path.join(WWW, 'assets');
  fs.mkdirSync(devAssets, { recursive: true });
  for (const f of ['mannequin.glb', 'walk.glb', 'run.glb', 'jump.glb']) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(devAssets, f));
  }
}

async function build() {
  const start = Date.now();
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    bundle: true,
    format: 'iife',
    target: ['es2019'],
    minify: !dev,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') }
  });
  const js = result.outputFiles[0].text;
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const outfile = path.join(WWW, 'index.html');
  writeIndex(js, css, outfile);
  const size = fs.statSync(outfile).size;
  console.log(`build ${dev ? '(dev)' : ''}: www/index.html ${(size / 1024).toFixed(0)} KB in ${Date.now() - start} ms`);
  return outfile;
}

await build();

if (watch) {
  console.log('watching for changes…');
  const dirs = [path.join(ROOT, 'src'), ROOT];
  for (const d of dirs) {
    fs.watch(d, { recursive: true }, (_e, file) => {
      if (!file) return;
      if (file.endsWith('.html') || file.endsWith('.css') || file.endsWith('.js')) {
        build().catch(e => console.error(e));
      }
    });
  }
}

if (serve) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(WWW, p);
    if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  });
  const port = Number(process.env.PORT || 8080);
  server.listen(port, '0.0.0.0', () => console.log(`serving www/ on http://0.0.0.0:${port}`));
}
