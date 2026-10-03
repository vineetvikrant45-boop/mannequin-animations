/**
 * Offline rig + animation verification (no GPU, no browser).
 *
 *   node tools/verify-rig.mjs            # numeric checks + filmstrips
 *   node tools/verify-rig.mjs --check    # numeric checks only
 *
 * It loads the real game assets, builds the rig exactly like the game does,
 * bakes the clips and then CPU-rasterises filmstrips into tools/out/*.png so the
 * motion can be eyeballed without a device.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'game', 'assets');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// three.js expects a browser-ish global in a couple of code paths
globalThis.self = globalThis;

const THREE = await import(path.join(ROOT, 'game', 'node_modules', 'three', 'build', 'three.module.js'));
const { GLTFLoader } = await import(path.join(ROOT, 'game', 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'));
const rigMod = await import(path.join(ROOT, 'game', 'src', 'char', 'rig.js'));

const loader = new GLTFLoader();
function parseGLB(file) {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

const [man, walk, run, jump] = await Promise.all([
  parseGLB('mannequin.glb'), parseGLB('walk.glb'), parseGLB('run.glb'), parseGLB('jump.glb')
]);

console.log('source clips:',
  [['walk', walk], ['run', run], ['jump', jump]].map(([n, g]) => {
    const c = g.animations[0];
    return `${n} dur=${c.duration.toFixed(3)}s tracks=${c.tracks.length}`;
  }).join(' | '));

const hero = rigMod.createMannequin(man, { walk, run, jump }, {});
const { bones, mixer, actions, durations } = hero;
console.log('baked clips:', Object.keys(durations).map(k => `${k}=${durations[k].toFixed(3)}s`).join(' '));

/* ------------------------------------------------------------------ posing */

// per-vertex part id (for colour-coded debug renders)
const PART_COLORS = [
  [90, 110, 140],   // 0 hips
  [70, 100, 200],   // 1 torso
  [240, 210, 90],   // 2 head
  [240, 210, 90],   // 3 neck
  [70, 190, 90],    // 4..6 left leg
  [70, 190, 90], [70, 190, 90],
  [220, 80, 80], [220, 80, 80], [220, 80, 80],   // 7..15 left arm+hand
  [220, 80, 80], [220, 80, 80], [220, 80, 80], [220, 80, 80], [220, 80, 80],
  [220, 80, 80], [220, 80, 80], [220, 80, 80],
  [40, 150, 70], [40, 150, 70], [40, 150, 70],   // 16..18 right leg
  [200, 60, 140], [200, 60, 140], [200, 60, 140],// 19..27 right arm+hand
  [200, 60, 140], [200, 60, 140], [200, 60, 140], [200, 60, 140], [200, 60, 140], [200, 60, 140]
];
const vertPart = new Uint8Array(man.scene.getObjectByProperty('isMesh', true).geometry.attributes.position.count);
{
  const parts = man.parser.json.meshes[0].extras.parts;
  let v = 0;
  for (let i = 0; i < parts.length; i++) for (let k = 0; k < parts[i].vertices; k++) vertPart[v++] = i;
}

const skin = hero.mesh;
const basePos = skin.geometry.attributes.position.array.slice();
const baseNor = skin.geometry.attributes.normal.array.slice();
const idx = skin.geometry.index.array;
const skinIdx = skin.geometry.attributes.skinIndex.array;
const skinW = skin.geometry.attributes.skinWeight.array;

function poseAt(actionName, t, weights) {
  mixer.setTime(0);
  for (const k of Object.keys(actions)) actions[k].setEffectiveWeight(k === actionName ? 1 : 0);
  actionName && actions[actionName] && (actions[actionName].time = t);
  mixer.update(0);
  hero.body.updateMatrixWorld(true);
  hero.bones[0].skeleton && hero.bones[0].skeleton.update();
  skin.skeleton.update();
  return skinGeomToWorld();
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
function boneMatrices() {
  const out = [];
  for (const b of bones) {
    out.push(new THREE.Matrix4().copy(b.matrixWorld).multiply(new THREE.Matrix4().copy(skin.skeleton.boneInverses[bones.indexOf(b)])));
  }
  return out;
}

/** Skinned vertex positions + normals in character space. */
function skinGeomToWorld() {
  skin.skeleton.update();
  const inv = skin.skeleton.boneInverses;
  const mats = [];
  for (let i = 0; i < bones.length; i++) {
    mats.push(new THREE.Matrix4().multiplyMatrices(bones[i].matrixWorld, inv[i]));
  }
  const n = basePos.length / 3;
  const pos = new Float32Array(basePos.length);
  const nor = new Float32Array(baseNor.length);
  const v = new THREE.Vector3(), nv = new THREE.Vector3();
  const acc = new THREE.Vector3(), accN = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (let i = 0; i < n; i++) {
    acc.set(0, 0, 0); accN.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = skinW[i * 4 + k];
      if (!w) continue;
      const m = mats[skinIdx[i * 4 + k]];
      v.set(basePos[i * 3], basePos[i * 3 + 1], basePos[i * 3 + 2]).applyMatrix4(m);
      acc.addScaledVector(v, w);
      nm.setFromMatrix4(m);
      nv.set(baseNor[i * 3], baseNor[i * 3 + 1], baseNor[i * 3 + 2]).applyMatrix3(nm).normalize();
      accN.addScaledVector(nv, w);
    }
    pos[i * 3] = acc.x; pos[i * 3 + 1] = acc.y; pos[i * 3 + 2] = acc.z;
    accN.normalize();
    nor[i * 3] = accN.x; nor[i * 3 + 1] = accN.y; nor[i * 3 + 2] = accN.z;
  }
  return { pos, nor };
}

/* ---------------------------------------------------------------- checks */

const report = [];
function jointWorld(name, idxOff = 0) {
  const i = rigMod.BONE_NAMES.indexOf(name);
  return new THREE.Vector3().setFromMatrixPosition(bones[i].matrixWorld);
}

for (const [name, dur] of [['walk', durations.walk], ['run', durations.run], ['jump', durations.jump]]) {
  const samples = 24;
  const stats = { footY: [Infinity, -Infinity], footZ: [], footX: [], hipY: [Infinity, -Infinity], minY: Infinity, maxY: -Infinity };
  for (let s = 0; s < samples; s++) {
    poseAt(name, (s / samples) * dur);
    const L = jointWorld('LeftFoot'), R = jointWorld('RightFoot'), H = jointWorld('Hips');
    stats.footY[0] = Math.min(stats.footY[0], L.y, R.y);
    stats.footY[1] = Math.max(stats.footY[1], L.y, R.y);
    stats.footZ.push(+(L.z).toFixed(3), +(R.z).toFixed(3));
    stats.footX.push(+(L.x).toFixed(3), +(R.x).toFixed(3));
    stats.hipY[0] = Math.min(stats.hipY[0], H.y);
    stats.hipY[1] = Math.max(stats.hipY[1], H.y);
    // whole-body vertical extent
    const { pos } = skinGeomToWorld();
    for (let i = 1; i < pos.length; i += 3) {
      stats.minY = Math.min(stats.minY, pos[i]);
      stats.maxY = Math.max(stats.maxY, pos[i]);
    }
  }
  const zSpan = Math.max(...stats.footZ) - Math.min(...stats.footZ);
  const xSpan = Math.max(...stats.footX) - Math.min(...stats.footX);
  report.push({
    clip: name,
    footY: stats.footY.map(v => +v.toFixed(3)),
    hipsY: stats.hipY.map(v => +v.toFixed(3)),
    meshY: [+stats.minY.toFixed(3), +stats.maxY.toFixed(3)],
    footSwingZ: +zSpan.toFixed(3),
    footSwingX: +xSpan.toFixed(3),
    facesZ: zSpan > xSpan * 1.4 ? 'yes (+Z forward)' : 'NO - check axis'
  });
}
console.table(report);

/* ------------------------------------------------------- software renderer */

const W = 240, H = 320;
function makeFrame() {
  return { rgb: new Uint8ClampedArray(W * H * 3), z: new Float32Array(W * H).fill(Infinity) };
}
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();
const EYE = new THREE.Vector3(-1.7, 1.5, 3.4);
const TARGET = new THREE.Vector3(0, 0.95, 0);

function drawFrame(frame, pos, nor, cam) {
  // Matrix4.lookAt only builds the rotation -> add the eye translation
  const camWorld = new THREE.Matrix4().lookAt(cam.eye, cam.target, new THREE.Vector3(0, 1, 0)).setPosition(cam.eye);
  const view = camWorld.clone().invert();
  const proj = new THREE.PerspectiveCamera(38, W / H, 0.05, 80).projectionMatrix;
  const vp = new THREE.Matrix4().multiplyMatrices(proj, view);

  const v4 = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    const sc = [];
    let skip = false;
    for (let k = 0; k < 3; k++) {
      const i = tri[k];
      v4[k].set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1).applyMatrix4(vp);
      if (v4[k].w <= 0.02) { skip = true; break; }
      // NDC -> screen, depth = view distance (w = -z_view)
      sc.push([((v4[k].x / v4[k].w) * 0.5 + 0.5) * W,
               (1 - (v4[k].y / v4[k].w * 0.5 + 0.5)) * H,
               v4[k].w]);
    }
    if (skip) continue;

    a.set(pos[tri[0] * 3], pos[tri[0] * 3 + 1], pos[tri[0] * 3 + 2]);
    b.set(pos[tri[1] * 3], pos[tri[1] * 3 + 1], pos[tri[1] * 3 + 2]);
    c.set(pos[tri[2] * 3], pos[tri[2] * 3 + 1], pos[tri[2] * 3 + 2]);
    const fn = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const toEye = cam.eye.clone().sub(a).normalize();
    const facing = fn.dot(toEye) > 0 ? 1 : -1;
    if (facing < 0 && !cam.twoSided) { /* backface: still draw, mannequin is closed */ }
    const nrm = fn.multiplyScalar(facing);
    const diff = Math.max(0, nrm.dot(LIGHT));
    const rim = Math.pow(1 - Math.max(0, nrm.dot(toEye)), 2.5) * 0.22;
    const shade = Math.min(1.35, 0.25 + 0.9 * Math.pow(diff, 0.9) + rim);
    const base = PART_COLORS[vertPart[tri[0]]] || [233, 233, 241];
    const col = [base[0] * shade, base[1] * shade, base[2] * shade];

    const minX = Math.max(0, Math.floor(Math.min(sc[0][0], sc[1][0], sc[2][0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sc[0][0], sc[1][0], sc[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(sc[0][1], sc[1][1], sc[2][1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sc[0][1], sc[1][1], sc[2][1])));
    const area = (sc[1][0] - sc[0][0]) * (sc[2][1] - sc[0][1]) - (sc[2][0] - sc[0][0]) * (sc[1][1] - sc[0][1]);
    if (Math.abs(area) < 1e-6) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((sc[1][0] - px) * (sc[2][1] - py) - (sc[2][0] - px) * (sc[1][1] - py)) / area;
        const w1 = ((sc[2][0] - px) * (sc[0][1] - py) - (sc[0][0] - px) * (sc[2][1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * sc[0][2] + w1 * sc[1][2] + w2 * sc[2][2];
        const o = y * W + x;
        if (z >= frame.z[o]) continue;
        frame.z[o] = z;
        frame.rgb[o * 3] = col[0]; frame.rgb[o * 3 + 1] = col[1]; frame.rgb[o * 3 + 2] = col[2];
      }
    }
  }
}

function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunks = [];
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

function filmstrip(name, cam, frames) {
  const cols = frames.length;
  const big = { rgb: new Uint8ClampedArray(W * cols * H * 3), w: W * cols, h: H };
  big.rgb.fill(24);
  for (let f = 0; f < cols; f++) {
    const frame = makeFrame();
    drawFrame(frame, frames[f].pos, frames[f].nor, cam);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const src = y * W + x, dst = y * big.w + (f * W + x);
        for (let c = 0; c < 3; c++) {
          const v = frame.z[src] === Infinity ? 18 : frame.rgb[src * 3 + c];
          big.rgb[dst * 3 + c] = v;
        }
      }
    }
  }
  writePNG(path.join(OUT, name + '.png'), big.w, big.h, big.rgb);
  console.log('wrote', path.join('tools/out', name + '.png'), big.w + 'x' + big.h);
}

if (!process.argv.includes('--check')) {
  const cams = {
    front: { eye: new THREE.Vector3(-1.35, 1.45, 3.1), target: TARGET },
    side: { eye: new THREE.Vector3(3.4, 1.25, 0.0), target: TARGET }
  };
  for (const [clip, dur] of [['walk', durations.walk], ['run', durations.run], ['jump', durations.jump], ['idle', durations.idle]]) {
    const frames = [];
    const N = 8;
    for (let i = 0; i < N; i++) {
      const g = poseAt(clip, (i / N) * dur);
      frames.push({ pos: g.pos, nor: g.nor });
    }
    filmstrip(`${clip}-side`, cams.side, frames);
  }
  // jump sequence with a floor grid reference
  const frames = [];
  for (let i = 0; i < 8; i++) frames.push(poseAt('jump', (i / 8) * durations.jump));
  filmstrip('walk-front', cams.front, frames);
}

/* --------------------------------------------------------------- debug hook */
if (process.argv.includes('--debug-draw')) {
  const cam = { eye: new THREE.Vector3(3.4, 1.25, 0.0), target: TARGET };
  const camWorld = new THREE.Matrix4().lookAt(cam.eye, cam.target, new THREE.Vector3(0, 1, 0)).setPosition(cam.eye);
  const view = camWorld.clone().invert();
  const proj = new THREE.PerspectiveCamera(38, W / H, 0.05, 80).projectionMatrix;
  const vp = new THREE.Matrix4().multiplyMatrices(proj, view);
  for (let i = 0; i < 4; i++) {
    const g = poseAt('walk', (i / 8) * durations.walk);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, nan = 0;
    const v4 = new THREE.Vector4();
    for (let k = 0; k < g.pos.length; k += 3) {
      if (!Number.isFinite(g.pos[k])) { nan++; continue; }
      v4.set(g.pos[k], g.pos[k + 1], g.pos[k + 2], 1).applyMatrix4(vp);
      if (v4.w <= 0.02) continue;
      const sx = (v4.x / v4.w * 0.5 + 0.5) * W, sy = (1 - (v4.y / v4.w * 0.5 + 0.5)) * H;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    console.log('frame', i, 'nan', nan, 'screen', minX.toFixed(1), maxX.toFixed(1), minY.toFixed(1), maxY.toFixed(1));
  }
}
