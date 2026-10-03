/**
 * The playground: ground, fence, swing set, slide, merry-go-round, seesaw,
 * sandbox, spring rider, trees, lamps, balloons, clouds, fireflies, day-night
 * cycle and drop-in bouncy balls.
 *
 * Everything static is merged per material at build time — the whole park lands
 * at a couple of dozen draw calls, and the collider list is exported directly.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const MAT = (color, extra) => new THREE.MeshLambertMaterial({ color, ...extra });

/* ------------------------------------------------------------- textures */

function noiseTexture(size, base, dots, repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  x.fillStyle = base;
  x.fillRect(0, 0, size, size);
  for (let i = 0; i < dots.count; i++) {
    x.fillStyle = dots.colors[i % dots.colors.length];
    const s = dots.min + Math.random() * (dots.max - dots.min);
    x.fillRect(Math.random() * size, Math.random() * size, s, s + Math.random() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  return t;
}

/* ----------------------------------------------------------- day cycle */

const SKY = {
  night: { top: new THREE.Color(0x030821), bot: new THREE.Color(0x12224e), sun: new THREE.Color(0x4459a8) },
  dusk: { top: new THREE.Color(0x2b2a72), bot: new THREE.Color(0xff9351), sun: new THREE.Color(0xffa14f) },
  day: { top: new THREE.Color(0x2262d4), bot: new THREE.Color(0xa8d9f8), sun: new THREE.Color(0xfff3cf) }
};

export class Playground {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.quality = opts.quality;
    this.scene = new THREE.Scene();
    this.colliders = [];        // [x, z, radius]
    this.balls = [];
    this.ballLimit = 18;
    this.time = opts.time === undefined ? 14 : opts.time;
    this.sunHeight = opts.sunHeight === undefined ? 0.62 : opts.sunHeight;
    this.dayCycle = !!opts.dayCycle;
    this.nightFactor = 0;
    this.shadowsOn = true;
    this._t = 0;
    this._tmp = new THREE.Vector3();
    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();

    this.scene.fog = new THREE.Fog(0x9dc9ee, 60, 210);
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildFence();
    this._buildSwings();
    this._buildSlide();
    this._buildCarousel();
    this._buildSeesaw();
    this._buildSandbox();
    this._buildRider();
    this._buildTrees();
    this._buildLamps();
    this._buildSkyProps();
    this._mergeStatic();
    this.setQuality(opts.quality, true);
    this.setTime(this.time, this.sunHeight);
  }

  /* -------------------------------------------------------------- sky */

  _buildSky() {
    this.skyUniforms = {
      topColor: { value: new THREE.Color(0x2262d4) },
      bottomColor: { value: new THREE.Color(0xa8d9f8) },
      sunColor: { value: new THREE.Color(0xfff3cf) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      offset: { value: 0.02 },
      exponent: { value: 0.72 }
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: `
          varying vec3 vWorld;
          void main(){
            vWorld = (modelMatrix * vec4(position,1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
          }`,
        fragmentShader: `
          uniform vec3 topColor, bottomColor, sunColor, sunDir;
          uniform float offset, exponent;
          varying vec3 vWorld;
          void main(){
            vec3 dir = normalize(vWorld);
            float f = pow(max(dir.y + offset, 0.0), exponent);
            vec3 col = mix(bottomColor, topColor, f);
            float sd = max(dot(dir, normalize(sunDir)), 0.0);
            col += sunColor * pow(sd, 220.0) * 1.5;
            col += sunColor * pow(sd, 12.0) * 0.12;
            gl_FragColor = vec4(col, 1.0);
          }`
      })
    );
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xbcdcff, 0x4d7a3f, 0.75);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0x88a6ff, 0.28);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff2d2, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    const s = 17;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.sunBase = new THREE.Vector3(26, 30, 18);
    this.rim = new THREE.DirectionalLight(0x88b6ff, 0.4);
    this.rim.position.set(-18, 12, -16);
    this.scene.add(this.rim);
  }

  /* ----------------------------------------------------------- ground */

  _buildGround() {
    const grassTex = noiseTexture(256, '#4c8b3c', {
      count: 2200, min: 1.6, max: 3.4,
      colors: ['rgba(122,186,80,0.42)', 'rgba(38,88,34,0.42)']
    }, 30);
    const grass = new THREE.Mesh(
      new THREE.CircleGeometry(96, 64),
      new THREE.MeshLambertMaterial({ map: grassTex })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.receiveShadow = true;
    this.scene.add(grass);

    const sandTex = noiseTexture(256, '#e3c18d', {
      count: 1500, min: 1.2, max: 3,
      colors: ['rgba(255,230,190,0.5)', 'rgba(180,140,95,0.42)']
    }, 12);
    this.pad = new THREE.Mesh(
      new THREE.CircleGeometry(15.5, 56),
      new THREE.MeshLambertMaterial({ map: sandTex })
    );
    this.pad.rotation.x = -Math.PI / 2;
    this.pad.position.y = 0.035;
    this.pad.receiveShadow = true;
    this.scene.add(this.pad);

    const ring = new THREE.Mesh(new THREE.RingGeometry(15.5, 16.15, 64), MAT(0xb98f5f));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.055;
    ring.receiveShadow = true;
    this.scene.add(ring);
  }

  /* ------------------------------------------------------------ fence */

  _buildFence() {
    const g = new THREE.Group();
    const postMat = MAT(0xf2f0e8), railMat = MAT(0xe9e5d8);
    const R = 27, sides = 4, perSide = 8;
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2 + Math.PI / 4;
      const a1 = ((s + 1) / sides) * Math.PI * 2 + Math.PI / 4;
      const p0 = new THREE.Vector3(Math.cos(a0) * R, 0, Math.sin(a0) * R);
      const p1 = new THREE.Vector3(Math.cos(a1) * R, 0, Math.sin(a1) * R);
      for (let i = 0; i < perSide; i++) {
        const p = p0.clone().lerp(p1, i / perSide);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 2.1, 8), postMat);
        post.position.copy(p);
        post.position.y = 1.05;
        g.add(post);
      }
      for (const hy of [0.95, 1.62]) {
        const dir = p1.clone().sub(p0);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(dir.length(), 0.13, 0.13), railMat);
        rail.position.copy(p0).lerp(p1, 0.5);
        rail.position.y = hy;
        rail.rotation.y = -Math.atan2(dir.z, dir.x);
        g.add(rail);
      }
    }
    this.fence = g;
    this.scene.add(g);
  }

  /* ----------------------------------------------------------- swings */

  _buildSwings() {
    const g = new THREE.Group();
    const frameMat = MAT(0xe8503a), beamMat = MAT(0xf2b134), ropeMat = MAT(0x3c4152);
    const beamY = 3.25, halfLen = 2.55, legLen = 3.5, tilt = 0.36;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, halfLen * 2, 12), beamMat);
    beam.rotation.z = Math.PI / 2;
    beam.position.y = beamY;
    g.add(beam);
    for (const x of [-halfLen, halfLen]) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, legLen, 10), frameMat);
        leg.position.set(x, beamY - (legLen / 2) * Math.cos(tilt), s * (legLen / 2) * Math.sin(tilt));
        leg.rotation.x = -s * tilt;
        g.add(leg);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.12, 10), MAT(0xd9432c));
        foot.position.set(x, 0.06, s * (legLen / 2) * Math.sin(tilt));
        g.add(foot);
      }
    }
    const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, halfLen * 2 - 0.4, 8), frameMat);
    brace.rotation.z = Math.PI / 2;
    brace.position.y = 1.15;
    g.add(brace);

    this.swings = [];
    const cols = [0x3a86c8, 0x4caf50, 0xe0526f];
    for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group();
      pivot.position.set(-1.85 + i * 1.85, beamY - 0.06, 0);
      const ropeLen = 1.95;
      for (const s of [-1, 1]) {
        const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, ropeLen, 6), ropeMat);
        rope.position.set(0, -ropeLen / 2, s * 0.29);
        pivot.add(rope);
      }
      const seat = new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.13, 0.62, 2, 0.05), MAT(cols[i]));
      seat.position.y = -ropeLen;
      pivot.add(seat);
      g.add(pivot);
      this.swings.push({ pivot, phase: i * 1.25, speed: 1.65 + i * 0.13 });
    }
    g.position.set(-6.2, 0, -3.4);
    g.rotation.y = 0.42;
    this.swingsGroup = g;
    this.scene.add(g);
    // colliders: the four legs
    const rot = (x, z, a) => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
    for (const [x, z] of [[-2.55, -1.2], [-2.55, 1.2], [2.55, -1.2], [2.55, 1.2]]) {
      const [rx, rz] = rot(x, z, 0.42);
      this.colliders.push([-6.2 + rx, -3.4 + rz, 0.3]);
    }
  }

  /* ------------------------------------------------------------ slide */

  _buildSlide() {
    const g = new THREE.Group();
    const woodMat = MAT(0xe2b26a), railMat = MAT(0xe8503a), deckMat = MAT(0x3a86c8);
    const slideMat = MAT(0x2fa8a0, { side: THREE.DoubleSide });
    const deck = new THREE.Mesh(new RoundedBoxGeometry(3.0, 0.22, 3.0, 2, 0.09), deckMat);
    deck.position.y = 2.4;
    g.add(deck);
    for (const x of [-1.25, 1.25]) for (const z of [-1.25, 1.25]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 2.4, 8), woodMat);
      leg.position.set(x, 1.2, z);
      g.add(leg);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.14, 8), MAT(0xc79055));
      foot.position.set(x, 0.07, z);
      g.add(foot);
    }
    for (const [x, z] of [[-1.42, -1.42], [1.42, -1.42], [-1.42, 1.42], [1.42, 1.42]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 1.25, 8), railMat);
      p.position.set(x, 3.12, z);
      g.add(p);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), MAT(0xf2b134));
      cap.position.set(x, 3.76, z);
      g.add(cap);
    }
    for (const z of [-1.42, 1.42]) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 2.84, 8), railMat);
      r.rotation.z = Math.PI / 2;
      r.position.set(0, 3.62, z);
      g.add(r);
      const r2 = r.clone();
      r2.position.y = 3.12;
      g.add(r2);
    }
    for (const x of [-1.42, 1.42]) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 2.84, 8), railMat);
      r.rotation.x = Math.PI / 2;
      r.position.set(x, 3.62, 0);
      g.add(r);
      const r2 = r.clone();
      r2.position.y = 3.12;
      g.add(r2);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.25, 4), MAT(0xe0526f));
    roof.position.y = 4.45;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 8), MAT(0xf2b134));
    knob.position.y = 5.15;
    g.add(knob);

    for (const x of [-0.62, 0.62]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.13, 2.55, 0.13), MAT(0xf2b134));
      r.position.set(x, 1.3, 1.95);
      r.rotation.x = -0.28;
      g.add(r);
    }
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const step = new THREE.Mesh(new RoundedBoxGeometry(1.32, 0.11, 0.32, 2, 0.04), deckMat);
      step.position.set(0, 0.28 + t * 2.05, 2.42 - t * 0.62);
      g.add(step);
    }

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 2.42, -1.55), new THREE.Vector3(0, 2.36, -2.35),
      new THREE.Vector3(0, 2.02, -3.35), new THREE.Vector3(0, 1.42, -4.35),
      new THREE.Vector3(0, 0.78, -5.35), new THREE.Vector3(0, 0.32, -6.35),
      new THREE.Vector3(0, 0.16, -7.15)
    ]);
    g.add(new THREE.Mesh(this._ribbon(curve, 1.65, 60, 0.3, 10), slideMat));
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const p = curve.getPointAt(t);
        const tan = curve.getTangentAt(t).normalize();
        const right = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
        pts.push(p.clone().addScaledVector(right, side * 0.83).add(new THREE.Vector3(0, 0.22, 0)));
      }
      const rc = new THREE.CatmullRomCurve3(pts);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(rc, 40, 0.115, 7, false), MAT(0xf2b134)));
    }
    g.position.set(6.4, 0, -4.2);
    g.rotation.y = -0.72;
    this.scene.add(g);
    this.colliders.push([6.4, -4.2, 1.9], [6.4 + 1.2, -4.2 + 1.6, 1.0]);
  }

  _ribbon(curve, width, segments, depth, across) {
    const points = curve.getSpacedPoints(segments);
    const pos = [], uv = [], idx = [];
    const up0 = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const p = points[i];
      const tan = curve.getTangentAt(Math.min(t, 1)).normalize();
      const right = new THREE.Vector3().crossVectors(tan, up0).normalize();
      const up = new THREE.Vector3().crossVectors(right, tan).normalize();
      for (let j = 0; j <= across; j++) {
        const s = j / across * 2 - 1;
        const v = p.clone().addScaledVector(right, s * width / 2).addScaledVector(up, depth * s * s);
        pos.push(v.x, v.y, v.z);
        uv.push(j / across, t * 5);
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < across; j++) {
        const a = i * (across + 1) + j, b = a + 1, c = a + across + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /* --------------------------------------------------------- carousel */

  _buildCarousel() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.15, 2.35, 0.3, 24), MAT(0x54606f));
    base.position.y = 0.16;
    g.add(base);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 0.18, 28), MAT(0xe0526f));
    disc.position.y = 0.42;
    g.add(disc);
    const discTop = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 0.06, 28), MAT(0xf2b134));
    discTop.position.y = 0.53;
    g.add(discTop);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 2.7, 10), MAT(0xd7dce2));
    pole.position.y = 1.85;
    g.add(pole);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.85, 8), MAT(0xd7dce2));
      bar.position.set(Math.cos(a) * 1.68, 1.45, Math.sin(a) * 1.68);
      g.add(bar);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8), MAT(0x3a86c8));
      cap.position.set(Math.cos(a) * 1.68, 2.4, Math.sin(a) * 1.68);
      g.add(cap);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.68, 0.1, 8, 32), MAT(0x3a86c8));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.32;
    g.add(ring);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.35, 1.05, 12), MAT(0x4caf50));
    canopy.position.y = 3.02;
    g.add(canopy);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), MAT(0xf2b134));
    top.position.y = 3.62;
    g.add(top);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + 0.4;
      const seat = new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.14, 0.5, 2, 0.05), MAT(0xe8503a));
      seat.position.set(Math.cos(a) * 1.68, 0.78, Math.sin(a) * 1.68);
      seat.rotation.y = -a;
      g.add(seat);
    }
    g.position.set(-4.6, 0, 5.6);
    this.carousel = { group: g, speed: 0.65, target: 0.65 };
    this.scene.add(g);
    this.colliders.push([-4.6, 5.6, 2.4]);
  }

  /* ----------------------------------------------------------- seesaw */

  _buildSeesaw() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.3, 0.28, 20), MAT(0x54606f));
    base.position.y = 0.14;
    g.add(base);
    const fulcrum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 1.25, 12), MAT(0xf2b134));
    fulcrum.position.y = 0.86;
    g.add(fulcrum);
    const pivot = new THREE.Group();
    pivot.position.y = 1.5;
    pivot.add(new THREE.Mesh(new RoundedBoxGeometry(5.4, 0.2, 0.72, 2, 0.07), MAT(0x3a86c8)));
    for (const s of [-1, 1]) {
      const seat = new THREE.Mesh(new RoundedBoxGeometry(0.85, 0.12, 0.72, 2, 0.05), MAT(0xe8503a));
      seat.position.set(s * 2.15, 0.16, 0);
      pivot.add(seat);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.075, 8, 16), MAT(0xd7dce2));
      handle.position.set(s * 1.62, 0.52, 0);
      handle.rotation.y = Math.PI / 2;
      pivot.add(handle);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.42, 8), MAT(0xd7dce2));
      stem.position.set(s * 1.62, 0.32, 0);
      pivot.add(stem);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.34, 4, 10), MAT(s < 0 ? 0x4caf50 : 0xe0526f));
      body.position.set(s * 2.05, 0.72, 0);
      pivot.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), MAT(0xffd9b0));
      head.position.set(s * 2.05, 1.13, 0);
      pivot.add(head);
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.12, 10), MAT(0xf2b134));
      hat.position.set(s * 2.05, 1.29, 0);
      pivot.add(hat);
    }
    g.add(pivot);
    g.position.set(4.6, 0, 5.2);
    g.rotation.y = -0.55;
    this.seesaw = { pivot, angle: 0 };
    this.scene.add(g);
    this.colliders.push([4.6, 5.2, 0.7]);
  }

  /* --------------------------------------------------------- sandbox */

  _buildSandbox() {
    const g = new THREE.Group();
    const sandTex = noiseTexture(256, '#e3c18d', {
      count: 900, min: 1, max: 2.4,
      colors: ['rgba(255,230,190,0.5)', 'rgba(180,140,95,0.42)']
    }, 3);
    const sand = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.28, 4.2), new THREE.MeshLambertMaterial({ map: sandTex }));
    sand.position.y = 0.16;
    g.add(sand);
    for (const [x, z, w, d] of [[0, -2.25, 4.7, 0.42], [0, 2.25, 4.7, 0.42], [-2.25, 0, 0.42, 4.7], [2.25, 0, 0.42, 4.7]]) {
      const b = new THREE.Mesh(new RoundedBoxGeometry(w, 0.42, d, 2, 0.08), MAT(0xc98b4e));
      b.position.set(x, 0.32, z);
      g.add(b);
    }
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.25, 0.42, 12), MAT(0xe8503a));
    bucket.position.set(1.05, 0.53, -1.1);
    g.add(bucket);
    const castle = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.5, 10), MAT(0xe6c491));
    castle.position.set(-0.5, 0.57, -0.7);
    g.add(castle);
    const castleTop = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.34, 10), MAT(0xe6c491));
    castleTop.position.set(-0.5, 0.99, -0.7);
    g.add(castleTop);
    g.position.set(1.6, 0, -9.4);
    g.rotation.y = 0.32;
    this.scene.add(g);
    this.colliders.push([1.6 + 2.9, -9.4 + 1.0, 0.6], [1.6 - 2.9, -9.4 - 0.6, 0.6]);
  }

  /* ----------------------------------------------------------- rider */

  _buildRider() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 0.18, 16), MAT(0x54606f));
    base.position.y = 0.09;
    g.add(base);
    const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.55, 10), MAT(0xd7dce2));
    spring.position.y = 0.46;
    g.add(spring);
    const body = new THREE.Group();
    body.position.y = 0.82;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 12), MAT(0x4caf50));
    torso.rotation.z = Math.PI / 2;
    body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), MAT(0x4caf50));
    head.position.set(0.62, 0.26, 0);
    body.add(head);
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), MAT(0x8bd47a));
    snout.position.set(0.88, 0.19, 0);
    body.add(snout);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 8), MAT(0x4caf50));
      ear.position.set(0.56, 0.55, s * 0.17);
      ear.rotation.z = -0.25;
      body.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), MAT(0x22262e));
      eye.position.set(0.86, 0.35, s * 0.16);
      body.add(eye);
    }
    const saddle = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 12), MAT(0xe8503a));
    saddle.position.set(-0.1, 0.32, 0);
    saddle.rotation.x = Math.PI / 2;
    body.add(saddle);
    g.add(body);
    g.position.set(-10.2, 0, 4.2);
    this.rider = { group: body, base: g };
    this.scene.add(g);
    this.colliders.push([-10.2, 4.2, 0.8]);
  }

  /* ----------------------------------------------------------- trees */

  _buildTrees() {
    const spots = [
      [-15.5, -9.5, 1.15, 0], [-18, 2.5, 1.0, 1], [-13.5, 11, 1.25, 2], [-4, 15, 0.95, 3],
      [8, 13.5, 1.1, 0], [16.5, 7, 1.2, 1], [18, -4, 1.05, 2], [13.5, -13, 1.15, 3],
      [2, -17, 1.0, 0], [-9, -15, 1.1, 1], [-20, -8, 0.9, 2], [20, 12, 0.95, 3]
    ];
    const cols = [0x3f8f3c, 0x4da347, 0x2f7a35, 0x63b04d];
    const blobs = [
      [0, 4.15, 0, 1.62], [1.15, 3.55, 0.55, 1.16], [-1.15, 3.62, 0.35, 1.12],
      [0.35, 3.5, -1.15, 1.05], [-0.55, 4.9, -0.45, 1.02], [0.85, 4.65, 0.75, 0.95]
    ];
    for (const [x, z, scale, hue] of spots) {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.38, 3.1, 8), MAT(0x7a5230));
      trunk.position.y = 1.55;
      g.add(trunk);
      const trunk2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.2, 6), MAT(0x7a5230));
      trunk2.position.set(0.35, 2.6, 0.15);
      trunk2.rotation.z = -0.5;
      g.add(trunk2);
      blobs.forEach((b, i) => {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(b[3], 1), MAT(cols[(i + hue) % cols.length]));
        m.position.set(b[0], b[1], b[2]);
        m.scale.setScalar(1 + (Math.sin(i * 12.9898 + x) * 0.5) * 0.14);
        g.add(m);
      });
      g.position.set(x, 0, z);
      g.scale.setScalar(scale);
      this.scene.add(g);
      this.colliders.push([x, z, 0.42 * scale]);
    }
    // bushes
    for (const [x, z, s] of [[-12, -2, 1], [-11, 7, 0.9], [11, 2, 1.05], [7, -11, 0.95], [-3, -12, 0.85], [13, 9, 0.9], [-16, 7, 0.85], [3, 11, 0.95]]) {
      const g = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const r = 0.72 + Math.random() * 0.42;
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), MAT([0x3d8c3c, 0x4c9c45, 0x2f7534][i % 3]));
        m.position.set((Math.random() - 0.5) * 1.1, r * 0.72, (Math.random() - 0.5) * 1.1);
        g.add(m);
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(s);
      this.scene.add(g);
      this.colliders.push([x, z, 0.85 * s]);
    }
    // flowers
    const colors = [0xff6b8b, 0xffd24a, 0xff8c42, 0xc06bff, 0xffffff];
    this.flowerGroup = new THREE.Group();
    const n = Math.max(40, Math.min(120, this.quality ? this.quality.grass / 6 : 80));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = 17 + Math.random() * 8;
      const g = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 4), MAT(0x4c9c45));
      stem.position.y = 0.16;
      g.add(stem);
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), MAT(colors[i % colors.length]));
      head.position.y = 0.35;
      g.add(head);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.flowerGroup.add(g);
    }
    this.scene.add(this.flowerGroup);
  }

  /* ----------------------------------------------------------- lamps */

  _buildLamps() {
    this.lampLights = [];
    const lampGlass = new THREE.MeshStandardMaterial({
      color: 0xffe9b0, emissive: 0xffcb72, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.1
    });
    const spots = [[-13.5, -11.5], [13.8, -11.2], [-13.2, 11.6], [13.4, 11.4]];
    spots.forEach(([x, z], i) => {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 4.3, 8), MAT(0x2c3440));
      pole.position.y = 2.15;
      g.add(pole);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.28, 10), MAT(0x2c3440));
      base.position.y = 0.14;
      g.add(base);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.9, 8), MAT(0x2c3440));
      arm.position.set(0.4, 4.28, 0);
      arm.rotation.z = -Math.PI / 2.35;
      g.add(arm);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), lampGlass);
      bulb.position.set(0.82, 4.32, 0);
      g.add(bulb);
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.34, 10), MAT(0x2c3440));
      hood.position.set(0.82, 4.62, 0);
      g.add(hood);
      let light = null;
      if (i % 2 === 0) {
        light = new THREE.PointLight(0xffc978, 0, 14, 2);
        light.position.set(0.82, 4.25, 0);
        g.add(light);
      }
      g.position.set(x, 0, z);
      this.scene.add(g);
      this.lampLights.push({ light, glass: lampGlass });
      this.colliders.push([x, z, 0.4]);
    });
  }

  /* ------------------------------------------------------- sky props */

  _buildSkyProps() {
    // clouds
    this.clouds = [];
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, fog: false });
    const cloudCount = this.quality ? this.quality.clouds : 6;
    for (let i = 0; i < cloudCount; i++) {
      const g = new THREE.Group();
      const n = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < n; j++) {
        const r = 1.9 + Math.random() * 2.2;
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), cloudMat);
        m.position.set((Math.random() - 0.5) * 7.5, (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 4.2);
        m.scale.y = 0.58;
        g.add(m);
      }
      const a = Math.random() * Math.PI * 2, rad = 40 + Math.random() * 55;
      g.position.set(Math.cos(a) * rad, 22 + Math.random() * 12, Math.sin(a) * rad);
      g.scale.setScalar(0.8 + Math.random() * 0.7);
      this.scene.add(g);
      this.clouds.push({ g, speed: 0.22 + Math.random() * 0.42 });
    }

    // balloons
    this.balloons = [];
    const bcols = [0xff5d6c, 0xffc94a, 0x59c2ff, 0x9d6bff, 0x4dd08a, 0xff8f4a];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      const r = 0.5 + Math.random() * 0.32;
      const b = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), MAT(bcols[i % bcols.length]));
      b.scale.y = 1.16;
      g.add(b);
      const knot = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.17, 8), MAT(bcols[i % bcols.length]));
      knot.position.y = -r * 1.16;
      knot.rotation.x = Math.PI;
      g.add(knot);
      const str = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.2, 4), MAT(0xf3f3f3));
      str.position.y = -r * 1.16 - 1.1;
      g.add(str);
      const a = Math.random() * Math.PI * 2, rad = 6 + Math.random() * 12;
      g.position.set(Math.cos(a) * rad, 5.5 + Math.random() * 4.5, Math.sin(a) * rad);
      this.scene.add(g);
      this.balloons.push({ g, ph: Math.random() * Math.PI * 2, sp: 0.4 + Math.random() * 0.5, baseY: g.position.y });
    }

    // fireflies (night only)
    const N = this.quality ? this.quality.fireflies : 0;
    this.fireflies = null;
    if (N > 0) {
      const pos = new Float32Array(N * 3);
      this.fireflySeeds = [];
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 26;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = 0.6 + Math.random() * 6;
        pos[i * 3 + 2] = Math.sin(a) * r;
        this.fireflySeeds.push({ sp: 0.25 + Math.random() * 0.8, ph: Math.random() * Math.PI * 2, base: pos[i * 3 + 1] });
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.22, color: 0xffe08a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      this.fireflies = new THREE.Points(geo, mat);
      this.fireflies.frustumCulled = false;
      this.scene.add(this.fireflies);
    }
  }

  /* ------------------------------------------------- merge static art */

  _mergeStatic() {
    // dynamic pieces keep their own transforms
    const keep = new Set();
    const mark = (o) => o.traverse(c => keep.add(c));
    this.swings.forEach(s => mark(s.pivot));
    mark(this.carousel.group);
    mark(this.seesaw.pivot);
    mark(this.rider.group);
    this.balloons.forEach(b => mark(b.g));
    this.clouds.forEach(c => mark(c.g));
    mark(this.flowerGroup);

    this.scene.updateMatrixWorld(true);
    const buckets = new Map();
    const dead = [];
    this.scene.traverse(o => {
      if (!o.isMesh || keep.has(o)) return;
      const m = o.material;
      if (!m.isMeshLambertMaterial || m.transparent || m.map) return;
      const key = m.color.getHex() + '|' + m.side;
      let g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      g.deleteAttribute('uv');
      if (g.index) g = g.toNonIndexed();
      if (g.attributes.skinIndex) return;
      if (!buckets.has(key)) buckets.set(key, { material: m, geos: [] });
      buckets.get(key).geos.push(g);
      dead.push(o);
    });
    for (const o of dead) {
      o.parent.remove(o);
      o.geometry.dispose();
    }
    for (const { material, geos } of buckets.values()) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      geos.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
    }
  }

  /* ------------------------------------------------------------ balls */

  dropBall(x, z, speedBoost = 0) {
    const r = 0.26 + Math.random() * 0.16;
    const cols = [0xff5d6c, 0xffc94a, 0x59c2ff, 0x9d6bff, 0x4dd08a, 0xff8f4a, 0xffffff];
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 14, 10),
      MAT(cols[Math.floor(Math.random() * cols.length)])
    );
    mesh.position.set(x, 7 + Math.random() * 3, z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.balls.push({
      mesh, r,
      vel: new THREE.Vector3((Math.random() - 0.5) * 2.2, -1.2 - speedBoost, (Math.random() - 0.5) * 2.2),
      life: 0,
      spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(2.4)
    });
    while (this.balls.length > this.ballLimit) {
      const old = this.balls.shift();
      this.scene.remove(old.mesh);
      old.mesh.geometry.dispose();
      old.mesh.material.dispose();
    }
  }

  /* ------------------------------------------------------------ state */

  setQuality(q, first = false) {
    this.quality = q;
    this.ballLimit = q.ballLimit;
    this.renderer.shadowMap.enabled = q.shadows && this.shadowsOn;
    if (this.sun) {
      this.sun.castShadow = q.shadows && this.shadowsOn;
      const size = q.shadowSize;
      if (!first && this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        if (this.sun.shadow.map) {
          this.sun.shadow.map.dispose();
          this.sun.shadow.map = null;
        }
      } else if (first) {
        this.sun.shadow.mapSize.set(size, size);
      }
    }
  }

  setShadows(on) {
    this.shadowsOn = on;
    this.renderer.shadowMap.enabled = on && !!(this.quality && this.quality.shadows);
    if (this.sun) this.sun.castShadow = this.renderer.shadowMap.enabled;
    this.scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
  }

  setTime(hours, sunHeight) {
    this.time = hours;
    if (sunHeight !== undefined) this.sunHeight = sunHeight;
    const angle = (hours / 24) * Math.PI * 2 - Math.PI / 2;
    const dist = 46;
    this.sun.position.set(
      Math.cos(angle) * dist,
      Math.sin(angle) * dist * this.sunHeight + 2.5,
      Math.sin(angle * 0.65) * 16 + 12
    );
    this.sunBase.copy(this.sun.position);

    const k = THREE.MathUtils.clamp(this.sun.position.y / 32, -1, 1);
    this.nightFactor = 1 - THREE.MathUtils.smoothstep(k, -0.12, 0.3);
    let top, bot, sunC;
    if (k < 0) {
      const f = THREE.MathUtils.clamp(k + 1, 0, 1);
      top = this._c1.copy(SKY.night.top).lerp(SKY.dusk.top, f).clone();
      bot = this._c2.copy(SKY.night.bot).lerp(SKY.dusk.bot, f).clone();
      sunC = SKY.night.sun.clone().lerp(SKY.dusk.sun, f);
    } else {
      const f = THREE.MathUtils.clamp(k / 0.55, 0, 1);
      top = SKY.dusk.top.clone().lerp(SKY.day.top, f);
      bot = SKY.dusk.bot.clone().lerp(SKY.day.bot, f);
      sunC = SKY.dusk.sun.clone().lerp(SKY.day.sun, f);
    }
    this.skyUniforms.topColor.value.copy(top);
    this.skyUniforms.bottomColor.value.copy(bot);
    this.skyUniforms.sunColor.value.copy(sunC);
    this.skyUniforms.sunDir.value.copy(this.sun.position).normalize();
    this.scene.fog.color.copy(bot);
    this.sun.color.copy(sunC);
    this.sun.intensity = 0.18 + Math.max(0, k) * 2.25;
    this.hemi.intensity = 0.16 + Math.max(0, k) * 0.85;
    this.hemi.color.copy(top).lerp(new THREE.Color(0xffffff), 0.45);
    this.ambient.intensity = 0.14 + this.nightFactor * 0.22;
    this.rim.intensity = 0.18 + (1 - Math.abs(k)) * 0.42;
    const lampPower = this.nightFactor * 2.5;
    for (const l of this.lampLights) {
      if (l.light) l.light.intensity = lampPower * 12;
    }
    if (this.lampLights[0]) this.lampLights[0].glass.emissiveIntensity = 0.25 + this.nightFactor * 2.4;
    if (this.fireflies) this.fireflies.material.opacity = this.nightFactor * 0.92;
    this.renderer.toneMappingExposure = 1.02 + this.nightFactor * 0.16;
    return { k, nightFactor: this.nightFactor };
  }

  /* -------------------------------------------------------------- tick */

  update(dt, elapsed, playerPos) {
    if (this.dayCycle) this.setTime((this.time + dt * 0.16) % 24);

    for (const s of this.swings) {
      s.pivot.rotation.x = Math.sin(elapsed * s.speed + s.phase) * 0.72;
    }
    this.carousel.target += (0.65 - this.carousel.target) * dt * 0.12;
    this.carousel.group.rotation.y += this.carousel.target * dt;
    this.seesaw.angle += (0 - this.seesaw.angle) * dt * 0.35;
    this.seesaw.pivot.rotation.z = this.seesaw.angle + Math.sin(elapsed * 1.25) * 0.135;
    this.rider.group.rotation.z = Math.sin(elapsed * 2.2) * 0.2;
    this.rider.group.position.y = 0.82 + Math.abs(Math.sin(elapsed * 2.2)) * 0.12;

    for (const b of this.balloons) {
      b.g.position.y = b.baseY + Math.sin(elapsed * b.sp + b.ph) * 0.75;
      b.g.rotation.z = Math.sin(elapsed * 0.62 + b.ph) * 0.13;
    }
    for (const c of this.clouds) {
      c.g.position.x += c.speed * dt * 1.25;
      if (c.g.position.x > 110) c.g.position.x = -110;
    }
    if (this.fireflies && this.nightFactor > 0.01) {
      const p = this.fireflies.geometry.attributes.position;
      const seeds = this.fireflySeeds;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        p.array[i * 3 + 1] = s.base + Math.sin(elapsed * s.sp + s.ph) * 0.62;
        p.array[i * 3] += Math.sin(elapsed * 0.42 + s.ph) * 0.006;
        p.array[i * 3 + 2] += Math.cos(elapsed * 0.37 + s.ph * 1.4) * 0.006;
      }
      p.needsUpdate = true;
    }

    // balls (simple but stable integrator)
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.life += dt;
      b.vel.y -= 16.5 * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.z += b.spin.z * dt;
      if (b.mesh.position.y < b.r) {
        b.mesh.position.y = b.r;
        b.vel.y *= -0.62;
        b.vel.x *= 0.93; b.vel.z *= 0.93;
        b.spin.multiplyScalar(0.86);
        if (Math.abs(b.vel.y) < 0.35) b.vel.y = 0;
      }
      if (b.life > 40 || b.mesh.position.length() > 70) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        this.balls.splice(i, 1);
      }
    }

    if (playerPos) {
      // shadow camera follows the player so the map stays crisp
      this.sun.position.copy(this.sunBase).add(playerPos);
      this.sun.target.position.copy(playerPos);
      this.sun.target.updateMatrixWorld();
    }
  }

  /** Resolve a circle against the static colliders + arena bounds. */
  collide(pos, radius = 0.32) {
    for (const [cx, cz, r] of this.colliders) {
      const ex = pos.x - cx, ez = pos.z - cz;
      const d = Math.hypot(ex, ez);
      const min = r + radius;
      if (d < min && d > 1e-4) {
        pos.x = cx + ex / d * min;
        pos.z = cz + ez / d * min;
      }
    }
    const lim = 18.4;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }
}
