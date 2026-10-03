/**
 * Mannequin rig + Mixamo motion retargeting.
 * ---------------------------------------------------------------
 * The uploaded mannequin is a single rigid mesh (no bones) with per-body-part
 * vertex ranges in its glTF `extras`. The three uploaded clips are Mixamo
 * *skeletons only* (no skin), 52 joints, centimetre units.
 *
 * So we do what a studio would do:
 *   1. build a Mixamo-named skeleton that matches the mannequin's rest pose,
 *   2. auto-skin the rigid mesh with per-part weights (smoothly blended across
 *      the joints, so the mannequin bends instead of popping),
 *   3. re-target the Mixamo motion onto it with world-space delta retargeting
 *      (bind-invariant, so the A-pose mannequin plays T-pose-authored clips
 *      correctly and the lowered arms are preserved),
 *   4. bake the result into uniform-rate clips (playback = pure slerp, cheap on
 *      mobile).
 */

import * as THREE from 'three';

/* ---------------------------------------------------------------- skeleton */

export const BONE_NAMES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'
];

const PARENT = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 0, 14, 15, 16, 0, 18, 19, 20];

/** Bind-pose joint positions in metres (mannequin rest pose, feet on y=0). */
const BIND_POS = [
  [0, .99, 0], [0, 1.04, 0], [0, 1.16, 0], [0, 1.29, 0], [0, 1.44, 0], [0, 1.50, 0],
  [-.035, 1.39, 0], [-.14, 1.345, 0], [-.155, 1.13, 0], [-.165, .87, 0],
  [.035, 1.39, 0], [.14, 1.345, 0], [.155, 1.13, 0], [.165, .87, 0],
  [-.075, .93, 0], [-.068, .535, 0], [-.062, .09, 0], [-.062, .03, .11],
  [.075, .93, 0], [.068, .535, 0], [.062, .09, 0], [.062, .03, .11]
];

/** Reference pose of the source Mixamo skeleton (same order as BONE_NAMES). */
const REF_ROT = [
  [.006458545995471647, 0, 0, .9999791433743128],
  [-.08015543156917052, 0, 0, .9967823768455981],
  [0, 0, 0, 1],
  [.012885409271979295, 0, 0, .999916979667759],
  [0, 0, 0, 1],
  [0, 0, 0, 1],
  [-.16242576496059946, .45146776860692767, -.8723504459017216, .09380524676751135],
  [-.02461566752642241, .0025622383689898743, -.10349858796972251, .9943216512452312],
  [0, 0, 0, 1], [0, 0, 0, 1],
  [-.16241494035985882, -.4514641086930379, .8723548002662612, .09380110960066573],
  [-.024607434417232652, -.0025615542645951767, .10350384632817101, .9943213094399745],
  [0, 0, 0, 1], [0, 0, 0, 1],
  [0, .010356598632428826, .999946368994241, 0],
  [-.03809132012641002, 0, 0, .9992742623179223],
  [.45974028749147416, 0, 0, .8880534150923902],
  [.3352419258915605, 0, 0, .9421320773248927],
  [0, .010367942663475628, .9999462514380095, 0],
  [-.03811224886926359, 0, 0, .9992734643160136],
  [.4597488121711071, 0, 0, .888049001861528],
  [.33524110372609595, 0, 0, .9421323698783037]
];

/** Source clips are authored in centimetres (Mixamo), mannequin is metres. */
export const CM_TO_M = 0.0095;

/* -------------------------------------------------- auto-skinning (weights) */

const TORSO_CH = [[.96, 0], [1.06, 1], [1.18, 2], [1.32, 3]];
const NECK_CH = [[1.36, 3], [1.44, 4], [1.5, 5]];
const LEG_R_CH = [[.07, 16], [.12, 15], [.49, 15], [.58, 14], [.9, 14], [.99, 0]];
const LEG_L_CH = [[.07, 20], [.12, 19], [.49, 19], [.58, 18], [.9, 18], [.99, 0]];
const ARM_R_CH = [[.85, 9], [.9, 8], [1.09, 8], [1.17, 7], [1.33, 7], [1.42, 3]];
const ARM_L_CH = [[.85, 13], [.9, 12], [1.09, 12], [1.17, 11], [1.33, 11], [1.42, 3]];

/** One channel per body part, in the order they appear in the mesh extras. */
const PART_CHANNELS = [
  { rigid: 0 }, { blend: TORSO_CH }, { rigid: 5 }, { blend: NECK_CH },
  { blend: LEG_L_CH }, { blend: LEG_L_CH }, { blend: LEG_L_CH },
  // Deltoid is a sphere centred on the shoulder joint: rigid to the arm bone
  // keeps it perfectly round (a partial weight would smear it on every frame).
  { rigid: 11 }, { blend: ARM_L_CH }, { blend: ARM_L_CH },
  { blend: ARM_L_CH }, { blend: ARM_L_CH }, { blend: ARM_L_CH },
  { blend: ARM_L_CH }, { blend: ARM_L_CH }, { blend: ARM_L_CH },
  { blend: LEG_R_CH }, { blend: LEG_R_CH }, { blend: LEG_R_CH },
  { rigid: 7 }, { blend: ARM_R_CH }, { blend: ARM_R_CH },
  { blend: ARM_R_CH }, { blend: ARM_R_CH }, { blend: ARM_R_CH },
  { blend: ARM_R_CH }, { blend: ARM_R_CH }, { blend: ARM_R_CH }
];

/** Fallback if the glTF extras are missing: original vertex ranges. */
const FALLBACK_RANGES = [
  [0, 410, null, 0], [410, 1058, 'torso'], [1058, 1896, null, 5], [1896, 2038, 'neck'],
  [2038, 3436, 'legL'], [3436, 5028, 'armL'], [5028, 6426, 'legR'], [6426, 8018, 'armR']
];
const FALLBACK_CH = { torso: TORSO_CH, neck: NECK_CH, legL: LEG_L_CH, legR: LEG_R_CH, armL: ARM_L_CH, armR: ARM_R_CH };

function blendFor(channel, y) {
  const c = channel.blend;
  if (y <= c[0][0]) return [c[0][1], 0, 0];
  if (y >= c[c.length - 1][0]) return [c[c.length - 1][1], 0, 0];
  for (let k = 0; k < c.length - 1; k++) {
    if (y <= c[k + 1][0]) {
      const w = (y - c[k][0]) / (c[k + 1][0] - c[k][0]);
      return [c[k][1], c[k + 1][1], w];
    }
  }
  return [c[c.length - 1][1], 0, 0];
}

function skinMesh(geometry, parts) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);

  if (Array.isArray(parts) && parts.length === PART_CHANNELS.length) {
    let v = 0;
    for (let i = 0; i < parts.length; i++) {
      const count = parts[i].vertices;
      const ch = PART_CHANNELS[i];
      for (let k = 0; k < count; k++, v++) {
        if (ch.rigid !== undefined) {
          si[v * 4] = ch.rigid; sw[v * 4] = 1;
        } else {
          const [b0, b1, w1] = blendFor(ch, pos.getY(v));
          si[v * 4] = b0; sw[v * 4] = 1 - w1;
          if (b1 !== b0) { si[v * 4 + 1] = b1; sw[v * 4 + 1] = w1; }
        }
      }
    }
  } else {
    for (const [a, b, key, fix] of FALLBACK_RANGES) {
      for (let v = a; v < b; v++) {
        if (key) {
          const [b0, b1, w1] = blendFor(FALLBACK_CH[key], pos.getY(v));
          si[v * 4] = b0; sw[v * 4] = 1 - w1;
          if (b1 !== b0) { si[v * 4 + 1] = b1; sw[v * 4 + 1] = w1; }
        } else {
          si[v * 4] = fix || 0; sw[v * 4] = 1;
        }
      }
    }
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geometry;
}

/* ------------------------------------------------------- bind skeleton build */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/* ------------------------------------------------------- bind pose mapping */

/** First child of each bone (used for limb directions). */
const CHILD_OF = (() => {
  const c = new Array(BONE_NAMES.length).fill(-1);
  for (let i = 0; i < PARENT.length; i++) if (PARENT[i] >= 0 && c[PARENT[i]] < 0) c[PARENT[i]] = i;
  return c;
})();

/** Reference (source) rest world rotations, chained from the Mixamo rest RS. */
const REF_WORLD = (() => {
  const out = [];
  for (let i = 0; i < BONE_NAMES.length; i++) {
    const p = PARENT[i];
    const q = new THREE.Quaternion().fromArray(REF_ROT[i]);
    out[i] = (p < 0 ? new THREE.Quaternion() : out[p].clone()).multiply(q).normalize();
  }
  return out;
})();

/**
 * Bind pose of the mannequin skeleton = the source rest pose (identical chain,
 * identical rest rotations) with the two upper arms swung down so they match
 * the mesh, which was modelled with the arms straight at the sides.
 */
export const ARM_CORR = (() => {
  const out = BONE_NAMES.map(() => null);
  for (const [armIdx, childIdx] of [[7, 8], [11, 12]]) {
    const srcDir = new THREE.Vector3(0, 1, 0).applyQuaternion(REF_WORLD[armIdx]).normalize();
    const dstDir = new THREE.Vector3().fromArray(BIND_POS[childIdx])
      .sub(new THREE.Vector3().fromArray(BIND_POS[armIdx])).normalize();
    out[armIdx] = new THREE.Quaternion().setFromUnitVectors(srcDir, dstDir);
  }
  return out;
})();

/** Bones that make up each arm, in skin-weight order (arm chain first). */
const ARM_CHAIN = [
  { joint: 7, bones: [7, 8, 9, 10], corr: null },      // right
  { joint: 11, bones: [11, 12, 13, 14], corr: null }   // left
];
ARM_CHAIN[0].corr = ARM_CORR[7];
ARM_CHAIN[1].corr = ARM_CORR[11];

export function buildBindSkeleton() {
  const bones = BONE_NAMES.map(n => {
    const b = new THREE.Bone();
    b.name = 'mannequin' + n;
    return b;
  });
  const bindWorld = [];
  const bindLocal = [];
  const inv = new THREE.Quaternion();
  const target = new THREE.Vector3();

  for (let i = 0; i < bones.length; i++) {
    const p = PARENT[i];
    bindWorld[i] = REF_WORLD[i].clone();
    if (ARM_CORR[i]) bindWorld[i].premultiply(ARM_CORR[i]).normalize();   // arms at the sides
    if (p < 0) {
      bindLocal[i] = bindWorld[i].clone();
      bones[i].position.fromArray(BIND_POS[i]);
    } else {
      inv.copy(bindWorld[p]).invert();
      bindLocal[i] = inv.clone().multiply(bindWorld[i]).normalize();
      target.fromArray(BIND_POS[i]).sub(_v.fromArray(BIND_POS[p]));
      target.applyQuaternion(inv.copy(bindWorld[p]).invert());
      bones[i].position.copy(target);
      bones[p].add(bones[i]);
    }
    bones[i].quaternion.copy(bindLocal[i]);
  }
  return { bones, bindWorld, bindLocal };
}

/** Sanity check: does the loaded clip's rest pose match the built-in reference? */
export function checkSourceRest(srcGltf, warn = console.warn) {
  const src = sourceProxies(srcGltf);
  const world = src.map.map(() => new THREE.Quaternion());
  chainWorldRotations(src.map, world, src.bindLocal, new THREE.Quaternion());
  let worst = 0, worstName = '';
  for (let i = 0; i < world.length; i++) {
    const ang = 2 * Math.acos(Math.min(1, Math.abs(world[i].dot(REF_WORLD[i])))) * 180 / Math.PI;
    if (ang > worst) { worst = ang; worstName = BONE_NAMES[i]; }
  }
  if (worst > 15) warn(`[rig] clip rest pose differs from reference (${worstName}: ${worst.toFixed(1)}°)`);
  return worst;
}

/* ------------------------------------------------------------- re-targeting */

/**
 * The uploaded Mixamo files are exported *flat*: every joint is a root node with
 * no `children` array and the scene lists no nodes at all. The hierarchy only
 * exists implicitly through the mixamorig naming convention, so we rebuild a
 * proxy object per joint (used purely to evaluate the clips) and walk the chain
 * ourselves using PARENT.
 */
const proxyCache = new WeakMap();
function sourceProxies(srcGltf) {
  if (proxyCache.has(srcGltf)) return proxyCache.get(srcGltf);
  const json = (srcGltf.parser && srcGltf.parser.json) || { nodes: [] };
  const root = new THREE.Group();
  root.name = 'mixamoSource';
  const byName = new Map();
  const byNameDef = new Map();
  for (const n of json.nodes || []) {
    const name = THREE.PropertyBinding.sanitizeNodeName(n.name || '');
    const o = new THREE.Object3D();
    o.name = name;
    if (n.translation) o.position.fromArray(n.translation);
    // NOTE: quaternion stays identity — the clip channels are authored in
    // Mixamo joint space (identity = bind pose), so the bind rotation of every
    // joint is kept aside and applied as a *pre*-rotation:  local = bind * q.
    root.add(o);
    byName.set(name, o);
    byNameDef.set(name, n);
  }
  const map = BONE_NAMES.map(n => byName.get('mixamorig' + n) || null);
  const bindLocal = BONE_NAMES.map(n => {
    const def = byNameDef.get('mixamorig' + n);
    return new THREE.Quaternion().fromArray((def && def.rotation) || [0, 0, 0, 1]);
  });
  const out = { root, map, bindLocal, hips: byName.get('mixamorigHips') || null };
  proxyCache.set(srcGltf, out);
  return out;
}

/**
 * World rotation of every source joint:  local = bindLocal * clipRotation
 * (clipRotation is the animated channel; identity means "bind pose").
 */
function chainWorldRotations(nodes, out, bindLocal, tmp) {
  for (let i = 0; i < nodes.length; i++) {
    const p = PARENT[i];
    if (!nodes[i]) { out[i].identity(); continue; }
    if (bindLocal) tmp.copy(bindLocal[i]).multiply(nodes[i].quaternion).normalize();
    else tmp.copy(nodes[i].quaternion).normalize();
    if (p < 0) out[i].copy(tmp);
    else out[i].copy(out[p]).multiply(tmp).normalize();
  }
  return out;
}

/**
 * Re-target one source clip onto the mannequin skeleton and return a baked
 * AnimationClip (uniform 30 fps quaternion tracks + hips height track).
 */
/**
 * Foot contact joints: ankles and toes, with the height each one sits above the
 * ground in a standing pose. Ground alignment keeps every joint at or above its
 * own standoff, which is what stops the character sinking into the floor when a
 * leg bends (and lifts the toes at push-off / the heels at strike).
 */
const FOOT_JOINTS = [
  { id: 16, tip: false }, { id: 20, tip: false },   // ankles
  { id: 17, tip: true }, { id: 21, tip: true }      // toes
];
const FOOT_CHAINS = {
  16: [0, 14, 15, 16], 17: [0, 14, 15, 16, 17],
  20: [0, 18, 19, 20], 21: [0, 18, 19, 20, 21]
};
/** Height of each source contact joint in the Mixamo standing pose (cm). */
const SRC_REST_Y = { 16: 8.73, 17: 0, 20: 8.73, 21: 0 };

/** Vertical position of a foot joint, given per-joint world rotations + local offsets. */
function chainY(ids, getQ, getOff, rootY) {
  let y = rootY;
  for (let k = 1; k < ids.length; k++) {
    y += _v.copy(getOff(ids[k])).applyQuaternion(getQ(ids[k - 1])).y;
  }
  return y;
}

export function bakeClip(srcGltf, clip, rig, opts = {}) {
  const { bones, bindWorld, bindLocal } = rig;
  const fps = opts.fps || 30;
  const rootLift = opts.rootLift === undefined ? 1 : opts.rootLift;
  const src = sourceProxies(srcGltf);
  const nodes = src.map;
  if (nodes[0] == null) throw new Error('source skeleton not found in clip');
  const count = bones.length;

  const mixer = new THREE.AnimationMixer(src.root);
  mixer.clipAction(clip).play();

  const duration = clip.duration;
  const hipsNode = src.hips || nodes[0];
  const srcNow = nodes.map(() => new THREE.Quaternion());
  const tmpLocal = new THREE.Quaternion();
  const armBones = [7, 11, 9, 13, 8, 12];   // sampled for the motion range

  /* ---- 1. reference pose + ground level -------------------------------
   * These Mixamo exports declare a bind pose that the animation never comes
   * back to (the arms stay ~70 deg away from it for the whole walk cycle), so
   * the retarget reference is measured from the clip itself: the average pose
   * of the cycle. The mannequin's rest then maps onto the middle of the motion
   * and the swings read correctly at the right amplitude.
   */
  const samples = Math.max(10, Math.min(60, Math.round(duration * fps)));
  const srcRef = nodes.map(() => new THREE.Quaternion());
  const firstPass = nodes.map(() => new THREE.Quaternion());
  let groundY = Infinity;
  for (let i = 0; i < samples; i++) {
    mixer.setTime((i / samples) * duration);
    chainWorldRotations(nodes, srcNow, src.bindLocal, tmpLocal);
    if (i === 0) for (let b = 0; b < count; b++) firstPass[b].copy(srcNow[b]);
    for (let b = 0; b < count; b++) {
      if (srcNow[b].dot(srcRef[b]) < 0) {
        srcNow[b].x = -srcNow[b].x; srcNow[b].y = -srcNow[b].y;
        srcNow[b].z = -srcNow[b].z; srcNow[b].w = -srcNow[b].w;
      }
      srcRef[b].x += srcNow[b].x; srcRef[b].y += srcNow[b].y;
      srcRef[b].z += srcNow[b].z; srcRef[b].w += srcNow[b].w;
    }
    const hipsY0 = hipsNode ? hipsNode.position.y : 0;
    for (const j of FOOT_JOINTS) {
      groundY = Math.min(groundY, chainY(FOOT_CHAINS[j.id], i => srcNow[i], i => nodes[i].position, hipsY0) - SRC_REST_Y[j.id]);
    }
  }
  for (let b = 0; b < count; b++) {
    if (srcRef[b].lengthSq() < 1e-6) srcRef[b].copy(firstPass[b]);
    srcRef[b].normalize();
  }

  /* ---- 2. bake -------------------------------------------------------- */
  const frames = Math.max(2, Math.round(duration * fps));
  const times = new Float32Array(frames + 1);
  const tracks = bones.map(() => new Float32Array((frames + 1) * 4));
  const world = bones.map(() => new THREE.Quaternion());
  const local = bones.map(() => new THREE.Quaternion());
  const lift = new Float32Array(frames + 1);
  const CM = CM_TO_M;

  for (let f = 0; f <= frames; f++) {
    const t = (f / frames) * duration;
    times[f] = t;
    mixer.setTime(t);
    chainWorldRotations(nodes, srcNow, src.bindLocal, tmpLocal);

    for (let i = 0; i < count; i++) {
      // motion delta of the source joint, replayed on the mannequin's rest pose
      world[i].copy(srcNow[i]).multiply(_q.copy(srcRef[i]).invert())
        .multiply(bindWorld[i]).normalize();
    }
    for (const i of RIGID_LEAVES) world[i].copy(world[PARENT[i]]);
    for (let i = 0; i < count; i++) {
      const p = PARENT[i];
      if (p < 0) local[i].copy(world[i]);
      else local[i].copy(world[p]).invert().multiply(world[i]);
      local[i].normalize().toArray(tracks[i], f * 4);
    }

    /* Foot planting: the hips follow the support foot (computed with forward
     * kinematics on both rigs) so the mannequin always walks on the ground
     * instead of sinking into it when a leg bends. */
    const hipsY0 = hipsNode ? hipsNode.position.y : 0;
    let srcAir = Infinity;
    for (const j of FOOT_JOINTS) {
      srcAir = Math.min(srcAir, chainY(FOOT_CHAINS[j.id], i => srcNow[i], i => nodes[i].position, hipsY0) - SRC_REST_Y[j.id]);
    }
    const airLift = Math.max(0, srcAir - groundY) * CM * rootLift;   // metres off the ground
    // keep every contact joint at or above its own standoff height
    let hold = -Infinity;
    for (const j of FOOT_JOINTS) {
      const bodyY = chainY(FOOT_CHAINS[j.id], i => world[i], i => bones[i].position, 0);
      hold = Math.max(hold, BIND_POS[j.id][1] - bodyY);
    }
    lift[f] = hold + airLift;
  }

  const out = new THREE.AnimationClip(clip.name || 'clip', duration, []);
  for (let i = 0; i < count; i++) {
    out.tracks.push(new THREE.QuaternionKeyframeTrack(bones[i].name + '.quaternion', times, tracks[i]));
  }
  const hipsTrack = new Float32Array((frames + 1) * 3);
  for (let f = 0; f <= frames; f++) hipsTrack[f * 3 + 1] = lift[f];
  out.tracks.push(new THREE.VectorKeyframeTrack('mannequinHips.position', times, hipsTrack));
  out.resetDuration();
  out.userData = { armRange: measureArmRange(tracks, frames, armBones) };
  return out;
}

/** Joints that ride rigidly with their parent (hands and toes only —
 *  index list must match BONE_NAMES: 9/13 are the hands, 17/21 the toes). */
const RIGID_LEAVES = [9, 13, 17, 21];

/** Peak-to-peak arm swing (degrees) — used to sanity check the retarget scale. */
function measureArmRange(tracks, frames, ids) {
  const _a = new THREE.Quaternion(), _b = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  for (const i of ids) {
    for (let f = 0; f <= frames; f++) {
      _a.fromArray(tracks[i], f * 4);
      const y = dir.set(0, 1, 0).applyQuaternion(_a).normalize().y;
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
  }
  return Math.round((Math.acos(Math.max(-1, Math.min(1, lo))) - Math.acos(Math.max(-1, Math.min(1, hi)))) * 180 / Math.PI);
}

/* ------------------------------------------------------------------- facade */

/**
 * Build the playable mannequin.
 * @param {object} mannequinGltf parsed glTF of the mannequin mesh
 * @param {object} clips  { walk, run, jump } parsed glTF skeletons with animation
 * @param {object} [opts]
 */
export function createMannequin(mannequinGltf, clips, opts = {}) {
  const rig = buildBindSkeleton();
  const { bones } = rig;

  const root = new THREE.Group();          // world transform of the character
  const body = new THREE.Group();          // holds skeleton + mesh
  root.add(body);

  // --- mesh -----------------------------------------------------------
  const src = mannequinGltf.scene.getObjectByProperty('isMesh', true);
  const geometry = src.geometry.clone();
  geometry.deleteAttribute('uv');          // no textures -> saves bandwidth
  const parts = mannequinGltf.parser && mannequinGltf.parser.json.meshes[0].extras
    && mannequinGltf.parser.json.meshes[0].extras.parts;
  skinMesh(geometry, parts);

  const material = new THREE.MeshLambertMaterial({
    color: opts.color === undefined ? 0xe9e9f0 : opts.color
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.frustumCulled = false;              // skinned bounds are the bind bounds
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  body.add(bones[0]);
  body.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);

  // --- silhouette details (orientation cues) --------------------------
  const badge = new THREE.Mesh(
    new THREE.CircleGeometry(0.075, 16),
    new THREE.MeshBasicMaterial({ color: 0xff8a3d })
  );
  badge.position.set(0, 0.12, 0.105);
  badge.rotation.y = Math.PI;              // face +Z (character forward)
  badge.renderOrder = 1;
  bones[3].add(badge);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.145, 0.035, 0.03),
    new THREE.MeshBasicMaterial({ color: 0x2b3648 })
  );
  visor.position.set(0, 0.035, 0.088);
  bones[5].add(visor);

  // --- clips ----------------------------------------------------------
  const baked = {};
  const durations = {};
  for (const key of Object.keys(clips)) {
    if (!clips[key]) continue;
    const g = clips[key];
    const clip = g.animations && g.animations[0];
    if (!clip) continue;
    baked[key] = bakeClip(g, clip, rig, {
      fps: key === 'jump' ? 32 : 30,
      rootLift: key === 'jump' ? (opts.jumpLift || 1.15) : 1
    });
    durations[key] = baked[key].duration;
  }

  // Idle: the mannequin's own rest pose plus a gentle breathing sway.
  baked.idle = buildIdleClip(bones, rig.bindLocal, opts.idleDuration || 3.2);
  durations.idle = baked.idle.duration;

  const mixer = new THREE.AnimationMixer(body);
  const actions = {};
  for (const k of Object.keys(baked)) {
    const a = mixer.clipAction(baked[k]);
    a.enabled = true;
    a.setEffectiveWeight(0);
    a.play();
    actions[k] = a;
  }
  if (actions.jump) {
    actions.jump.setLoop(THREE.LoopOnce, 1);
    actions.jump.clampWhenFinished = true;
  }
  if (actions.idle) actions.idle.setEffectiveWeight(1);

  return { root, body, mesh, bones, rig, mixer, actions, clips: baked, durations };
}

/** Read the pose of a baked clip at t = 0 (used as the idle's neutral). */
function basePoseFrom(clip, bones, fallback) {
  if (!clip) return fallback;
  const out = fallback.map(q => q.clone());
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const i = bones.findIndex(b => b.name === track.name.slice(0, -'.quaternion'.length));
    if (i < 0) continue;
    out[i].fromArray(track.values, 0).normalize();
  }
  return out;
}

/** 3.2 s procedural idle: breathing, weight shift, tiny head turn. */
function buildIdleClip(bones, bindLocal, duration) {
  const N = 22;
  const frames = [0, 0.8, 1.6, 2.4, 3.2];
  const tracks = [];
  const ease = (f) => Math.max(0, 1 - Math.abs(f - 1) * 0.35);
  for (let i = 0; i < N; i++) {
    const values = [];
    for (let f = 0; f < frames.length; f++) {
      const q = bindLocal[i].clone();
      const t = frames[f];
      if (i === 3) { // spine2: breathing
        _q.setFromAxisAngle(_v.set(1, 0, 0), 0.028 * (0.5 + 0.5 * Math.cos(t * 1.9)) * ease(f));
        q.multiply(_q);
      }
      if (i === 0) { // hips: subtle weight shift
        _q.setFromAxisAngle(_v.set(0, 0, 1), 0.018 * Math.sin(t * 1.25));
        q.multiply(_q);
      }
      if (i === 5) { // head: slow look around
        _q.setFromAxisAngle(_v.set(0, 1, 0), 0.13 * Math.sin(t * 0.95));
        q.multiply(_q);
        _q.setFromAxisAngle(_v.set(1, 0, 0), 0.03 * Math.sin(t * 1.3 + 1));
        q.multiply(_q);
      }
      if (i === 7 || i === 11) { // arms: gentle sway
        _q.setFromAxisAngle(_v.set(1, 0, 0), 0.035 * Math.sin(t * 1.1 + (i === 7 ? 0 : 0.7)));
        q.multiply(_q);
      }
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(bones[i].name + '.quaternion', frames, values));
  }
  const clip = new THREE.AnimationClip('idle', duration, tracks);
  clip.resetDuration();
  return clip;
}
