/**
 * Headless smoke test: runs the real game modules (world, player, camera,
 * animation state machine) for a few thousand simulated frames without a GPU.
 * Catches broken references, NaN leaks and controller regressions.
 *
 *   node tools/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.self = globalThis;

/* ------------------------------------------------ minimal browser stubs */
function fakeCanvas() {
  const ctx = new Proxy({}, {
    get: (_t, key) => {
      if (key === 'canvas') return { width: 256, height: 256 };
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      return () => {};
    },
    set: () => true
  });
  return {
    width: 256, height: 256, style: {},
    getContext: () => ctx,
    addEventListener() {}, removeEventListener() {}
  };
}
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, classList: { add(){}, remove(){}, toggle(){} }, addEventListener() {}, appendChild() {} }),
  createElementNS: () => fakeCanvas(),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: {} },
  body: { classList: { add(){}, remove(){}, toggle(){} }, appendChild() {} },
  readyState: 'complete'
};
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { userAgent: 'node', hardwareConcurrency: 4, deviceMemory: 4, vibrate: () => {} }
});
globalThis.devicePixelRatio = 2;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
globalThis.screen = { orientation: null };
globalThis.AudioContext = function () {
  return {
    currentTime: 0, sampleRate: 48000, state: 'running',
    createGain: () => ({ gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
    createOscillator: () => ({ type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }),
    createBuffer: () => ({ getChannelData: () => new Float32Array(64) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    createBiquadFilter: () => ({ type: '', frequency: { value: 0 }, connect() {} }),
    destination: {}, resume() {}
  };
};

/* ------------------------------------------------------------ the game */
const THREE = await import(path.join(ROOT, 'game/node_modules/three/build/three.module.js'));
const { GLTFLoader } = await import(path.join(ROOT, 'game/node_modules/three/examples/jsm/loaders/GLTFLoader.js'));
const { Playground } = await import(path.join(ROOT, 'game/src/world/playground.js'));
const { Player, FollowCamera } = await import(path.join(ROOT, 'game/src/player.js'));
const { createMannequin } = await import(path.join(ROOT, 'game/src/char/rig.js'));
const { presetFor } = await import(path.join(ROOT, 'game/src/core/quality.js'));

const loader = new GLTFLoader();
const parseGLB = (f) => new Promise((res, rej) => {
  const b = fs.readFileSync(path.join(ROOT, 'game/assets', f));
  loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej);
});

const preset = presetFor('high');
const stubRenderer = {
  shadowMap: { enabled: true, type: 0 },
  setPixelRatio() {}, setSize() {},
  toneMappingExposure: 1, outputColorSpace: '', toneMapping: 0
};

console.log('building world…');
const world = new Playground(stubRenderer, { quality: preset, time: 14 });
let meshes = 0, tris = 0;
world.scene.traverse(o => {
  if (!o.isMesh) return;
  meshes++;
  const g = o.geometry;
  tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
});
console.log(`world: ${meshes} meshes / ${tris | 0} triangles / ${world.colliders.length} colliders`);

const [mannequin, walk, run, jump] = await Promise.all([
  parseGLB('mannequin.glb'), parseGLB('walk.glb'), parseGLB('run.glb'), parseGLB('jump.glb')
]);
const hero = createMannequin(mannequin, { walk, run, jump }, {});
world.scene.add(hero.root);

const sfx = { enabled: false, jump() {}, land() {}, ring() {}, finish() {}, ui() {}, bounce() {}, setEnabled() {}, unlock() {} };
const player = new Player(hero, world, sfx);
const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.15, 480);
const follow = new FollowCamera(camera);
const settings = { camDistance: 5.4, camSens: 1, autoAlign: true, camHeight: 0.34 };

/* -------------------------------------------------------- simulated play */
const input = {
  vector: () => currentVector(),
  takeJump: () => { const j = jumpQueued; jumpQueued = false; return j; }
};
let currentVector = () => ({ x: 0, y: 0, mag: 0, sprint: false });
let jumpQueued = false;

const dt = 1 / 60;
let t = 0;
const log = [];
let worstY = 0, minY = 0, maxSpeed = 0, nanSeen = false;

function simFrame(seconds, mode) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    t += dt;
    currentVector = mode;
    player.camYaw = follow.yaw;
    player.update(dt, input);
    follow.update(dt, player, { dx: 0, dy: 0 }, settings);
    world.update(dt, t, player.position);
    const p = player.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(player.vertical)) nanSeen = true;
    worstY = Math.max(worstY, player.vertical);
    minY = Math.min(minY, player.vertical);
    maxSpeed = Math.max(maxSpeed, player.speed);
    if (player.position.length() > 40) throw new Error('player escaped the arena at t=' + t.toFixed(2));
  }
}

console.log('simulating walk…');
simFrame(3, () => ({ x: 0, y: 1, mag: 0.5, sprint: false }));
log.push(['walk', player.speed.toFixed(2), player.state]);

console.log('simulating run…');
simFrame(4, () => ({ x: 1, y: 0, mag: 1, sprint: false }));
log.push(['run', player.speed.toFixed(2), player.state]);

console.log('simulating joystick full circle + jumps…');
for (let a = 0; a < Math.PI * 2; a += 0.35) {
  simFrame(0.4, () => ({ x: Math.cos(a), y: Math.sin(a), mag: 1, sprint: true }));
  jumpQueued = true;
  simFrame(0.35, () => ({ x: Math.cos(a), y: Math.sin(a), mag: 1, sprint: true }));
}
log.push(['circle', player.speed.toFixed(2), player.state]);

console.log('simulating collisions (walk into every obstacle)…');
for (const [cx, cz] of world.colliders.map(c => [c[0], c[1]])) {
  const dx = cx - player.position.x, dz = cz - player.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const dir = { x: dx / len, y: dz / len };
  simFrame(0.8, () => ({ x: dir.x, y: dir.y, mag: 1, sprint: true }));
  jumpQueued = true;
  simFrame(0.4, () => ({ x: dir.x, y: dir.y, mag: 1, sprint: true }));
}
log.push(['collide', player.speed.toFixed(2), player.state]);

console.log('simulating balls + idle…');
for (let i = 0; i < 14; i++) world.dropBall(player.position.x + (Math.random() - 0.5) * 6, player.position.z + (Math.random() - 0.5) * 6);
simFrame(2, () => ({ x: 0, y: 0, mag: 0, sprint: false }));
simFrame(3, () => ({ x: 0, y: 1, mag: 0.3, sprint: false }));

console.log('simulating day/night cycle…');
for (const time of [0, 6, 12, 18, 23]) world.setTime(time);
for (const on of [true, false, true]) world.setShadows(on);
for (const q of ['low', 'medium', 'high']) world.setQuality(presetFor(q));

/* ------------------------------------------------------------- report */
console.log('\n--- results ---');
console.table(log.map(([phase, speed, state]) => ({ phase, speed, state })));
console.log('max jump height:', worstY.toFixed(2), 'm');
console.log('lowest y:', minY.toFixed(3), '(should be 0)');
console.log('max speed:', maxSpeed.toFixed(2), 'm/s');
console.log('nan:', nanSeen);
console.log('animation weights:', Object.entries(player.weights).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '));
console.log('balls alive:', world.balls.length);
console.log('hero world pos:', player.position.toArray().map(v => v.toFixed(2)).join(', '));

const problems = [];
if (nanSeen) problems.push('NaN in player state');
if (minY < -0.001) problems.push('player sank below the ground');
if (worstY < 0.4 || worstY > 3) problems.push('implausible jump height: ' + worstY.toFixed(2));
if (maxSpeed < 4 || maxSpeed > 7) problems.push('implausible run speed: ' + maxSpeed.toFixed(2));
if (player.position.length() > 30) problems.push('player far outside the play area');
if (problems.length) {
  console.error('\nSMOKE TEST FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('\nsmoke test OK');
