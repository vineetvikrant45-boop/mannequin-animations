/**
 * Game shell: renderer, asset loading, the parkour ring challenge, quality
 * management and the frame loop.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createMannequin } from './char/rig.js';
import { Playground } from './world/playground.js';
import { Player, FollowCamera } from './player.js';
import { Controls } from './core/input.js';
import { Sfx } from './core/audio.js';
import { UI } from './ui.js';
import { loadSettings, saveSettings, resetSettings, loadRecords, saveRecords, DEFAULTS } from './core/settings.js';
import { presetFor, PerformanceGovernor, guessPreset } from './core/quality.js';

const RING_COUNT = 8;
const RING_RADIUS = 0.95;

export class Game {
  constructor() {
    this.s = loadSettings();
    this.records = loadRecords();
    this.canvas = document.getElementById('scene');
    this.running = false;
    this.elapsed = 0;
    this.rings = 0;
    this.ringNodes = [];
    this.ringPulse = 0;
  }

  async init() {
    this.ui = new UI(this.s, {
      onLayout: () => { this.controls.applyLayout(); this.controls.sprintHeld = false; this._applySprintMode(); },
      onSettings: () => this._applySettings(),
      onQuality: () => { this._setQuality(presetFor(this.s.quality), true); },
      onEdit: (on) => this.controls.setEditing(on),
      onReset: () => {
        const fresh = JSON.parse(JSON.stringify(DEFAULTS));
        this.s.joy = fresh.joy; this.s.btn = fresh.btn; this.s.opacity = fresh.opacity;
        this.s.camDistance = fresh.camDistance; this.s.camSens = fresh.camSens;
        this._applySettings(); this.controls.applyLayout();
      },
      onBalls: () => this._dropBalls(),
      onFullscreen: () => this._toggleFullscreen(),
      onCheer: () => this._cheer()
    });
    this.ui.setLoading(0.05, 'Starting the engine…');

    // ---- renderer ----
    const preset = presetFor(this.s.quality);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true
    });
    this.renderer.setPixelRatio(this._pixelRatio(preset));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = preset.shadows && this.s.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.governor = new PerformanceGovernor();
    this.baseDpr = Math.min(devicePixelRatio || 1, preset.dpr);

    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.15, 480);
    this.follow = new FollowCamera(this.camera);

    // ---- world ----
    this.ui.setLoading(0.15, 'Building the playground…');
    this.world = new Playground(this.renderer, {
      quality: preset, time: this.s.time, sunHeight: this.s.sunHeight, dayCycle: this.s.dayCycle
    });
    this.scene = this.world.scene;

    // ---- audio ----
    this.sfx = new Sfx(this.s.sfx);

    // ---- input ----
    this.controls = new Controls(this.s, (persist) => {
      this.controls.applyLayout();
      if (persist) saveSettings(this.s);
    });
    this._applySprintMode();
    document.body.classList.toggle('sprint-button', this.s.sprint === 'button');

    // ---- character + clips ----
    this.ui.setLoading(0.25, 'Loading the mannequin…');
    const pack = await this._loadAssets();
    this.ui.setLoading(0.8, 'Wiring up the animations…');
    await new Promise(r => requestAnimationFrame(r));   // let the loader paint

    this.hero = createMannequin(pack.mannequin, {
      walk: pack.walk, run: pack.run, jump: pack.jump
    }, { jumpLift: 1.15 });
    this.scene.add(this.hero.root);

    this.player = new Player(this.hero, this.world, this.sfx);
    this._buildRings();

    // ---- misc ----
    this.clock = new THREE.Clock();
    this._fpsTimer = 0; this._fpsFrames = 0;
    addEventListener('resize', () => this._resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.running = false; }
      else if (!this.running) { this.running = true; this.clock.getDelta(); requestAnimationFrame(this._loop); }
    });
    const unlock = () => { this.sfx.unlock(); document.body.classList.remove('need-tap'); };
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('touchstart', unlock, { once: true });
    this._applySettings();
    this.controls.applyLayout();

    this.ui.setLoading(1, 'Ready!');
    setTimeout(() => this.ui.hideLoader(), 250);

    this.running = true;
    requestAnimationFrame(this._loop);
  }

  _pixelRatio(preset) {
    const dpr = Math.min(devicePixelRatio || 1, preset.dpr);
    const scale = (this.governor ? this.governor.scale : 1);
    let ratio = dpr * scale;
    // keep the total pixel count inside the preset's budget (mobile GPUs hate fill rate)
    const pixels = innerWidth * innerHeight * ratio * ratio;
    if (pixels > preset.pixelBudget) ratio = Math.sqrt(preset.pixelBudget / (innerWidth * innerHeight));
    return Math.max(0.5, ratio);
  }

  /**
   * Asset locations. The packaged build (build.mjs --inline) ships base64 data
   * URIs so nothing has to be fetched from the file system; the plain .glb
   * files sitting next to the page are the fallback for WebViews that refuse
   * data: requests.
   */
  static FILES = {
    mannequin: 'assets/mannequin.glb',
    walk: 'assets/walk.glb',
    run: 'assets/run.glb',
    jump: 'assets/jump.glb'
  };

  async _loadAssets() {
    const loader = new GLTFLoader();
    const inlined = (typeof window !== 'undefined' && window.MANNEQUIN_ASSETS) || {};
    const parse = (url) => new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, (e) => reject(e || new Error(`could not load ${url}`)));
    });
    /** inline data URI first (if the build provided one), then the loose file. */
    const load = async (name) => {
      const primary = inlined[name];
      const fallback = Game.FILES[name];
      if (typeof primary === 'string' && primary && primary.indexOf('{GLB:') !== 0) {
        try { return await parse(primary); }
        catch (e) {
          if (!fallback) throw e;
          console.warn(`[assets] inlined ${name} failed, trying ${fallback}`, e);
        }
      }
      return parse(fallback);
    };
    const [mannequin, walk, run, jump] = await Promise.all(
      ['mannequin', 'walk', 'run', 'jump'].map(load));
    return { mannequin, walk, run, jump };
  }

  /* ------------------------------------------------------------- rings */

  _buildRings() {
    const geo = new THREE.TorusGeometry(RING_RADIUS, 0.09, 8, 24);
    const mat = new THREE.MeshLambertMaterial({ color: 0x9be7ff, emissive: 0x1c5f78 });
    const inner = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 });
    this.ringGroup = new THREE.Group();
    this.scene.add(this.ringGroup);
    // a course that forces the player to use the whole park
    const layout = [
      [4.5, 0, 0.0], [9.0, -2.5, 0.2], [10.5, -8.0, 0.35], [4.0, -12.0, 0.2],
      [-2.0, -11.5, 0.0], [-8.0, -8.0, 0.15], [-12.0, -1.5, 0.3], [-9.5, 6.0, 0.0]
    ];
    for (let i = 0; i < RING_COUNT; i++) {
      const [x, z, y] = layout[i % layout.length];
      const node = new THREE.Group();
      const ring = new THREE.Mesh(geo, mat);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(RING_RADIUS - 0.06, 20), inner);
      ring.add(disc);
      node.add(ring);
      node.position.set(x, 1.15 + y, z);
      this.ringGroup.add(node);
      this.ringNodes.push({ node, ring, taken: false, baseY: node.position.y, spin: 0.7 + Math.random() * 0.5 });
    }
  }

  _resetRings() {
    for (const r of this.ringNodes) {
      r.taken = false;
      r.node.visible = true;
      r.node.scale.setScalar(1);
      r.ring.material = this.ringNodes.allTaken ? r.ring.material : r.ring.material;
    }
    this.rings = 0;
    this.ui.setRings(0);
    this.ringStart = performance.now();
    this.courseActive = true;
    for (const r of this.ringNodes) r.ring.material = this._ringMatNormal || r.ring.material;
  }

  _checkRings(dt) {
    const p = this.player.position;
    const py = 1.0 + this.player.vertical;
    for (const r of this.ringNodes) {
      if (r.taken) continue;
      const dx = p.x - r.node.position.x;
      const dy = py - r.node.position.y;
      const dz = p.z - r.node.position.z;
      if (dx * dx + dy * dy + dz * dz < RING_RADIUS * RING_RADIUS) {
        r.taken = true;
        this.rings++;
        this.ui.setRings(this.rings);
        this.world.setTime(this.world.time);
        r.node.visible = false;
        this.ringPulse = 1;
        this.sfx.ring(this.rings % 5);
        if (this.sfx.enabled && this.s.haptics && navigator.vibrate) navigator.vibrate(18);
        if (this.rings >= RING_COUNT) this._finishCourse();
      }
    }
  }

  _finishCourse() {
    const time = (performance.now() - this.ringStart) / 1000;
    const best = this.records.best;
    const isBest = !best || time < best;
    if (isBest) { this.records.best = time; saveRecords(this.records); }
    this.courseActive = false;
    this.sfx.finish();
    this.ui.showResult(RING_COUNT, best ? best.toFixed(1) + 's' : '—', isBest);
    this.ui.toast(`All ${RING_COUNT} rings in ${time.toFixed(1)}s`);
    setTimeout(() => this._resetRings(), 2600);
  }

  /* ------------------------------------------------------------ actions */

  _dropBalls() {
    for (let i = 0; i < 12; i++) {
      setTimeout(() => {
        const a = Math.random() * Math.PI * 2;
        const radius = Math.random() * 8;
        this.world.dropBall(this.player.position.x + Math.cos(a) * radius,
          this.player.position.z + Math.sin(a) * radius);
      }, i * 70);
    }
  }

  _cheer() {
    const a = this.hero.actions;
    if (!a.jump) return;
    a.jump.reset().play();
    a.jump.setEffectiveWeight(1);
    a.jump.time = 0.55;
    this.cheerUntil = this.elapsed + this.hero.durations.jump;
  }

  _toggleFullscreen() {
    const d = document.documentElement;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        Promise.resolve((d.requestFullscreen || d.webkitRequestFullscreen).call(d))
          .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
          .catch(() => {});
      }
    } catch (e) { /* not supported */ }
  }

  _applySprintMode() {
    document.body.classList.toggle('sprint-button', this.s.sprint === 'button');
  }

  _applySettings() {
    this.controls.applyLayout();
    document.body.classList.toggle('sprint-button', this.s.sprint === 'button');
    this.controls.s = this.s;
    this.ui.toggle('btnShadows', this.s.shadows);
    this.world.setShadows(this.s.shadows);
    this.world.dayCycle = this.s.dayCycle;
    this.world.setTime(this.s.time, this.s.sunHeight);
    this.hero.mesh.material.needsUpdate = true;
    this.sfx.setEnabled(this.s.sfx);
    saveSettings(this.s);
  }

  _setQuality(preset, manual) {
    this.baseDpr = Math.min(devicePixelRatio || 1, preset.dpr);
    this.renderer.setPixelRatio(this._pixelRatio(preset));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.governor.enabled = (this.s.quality === 'auto');
    if (manual && this.governor) this.governor.scale = 1;
    this.world.setQuality(preset);
    this.world.setShadows(this.s.shadows);
    this._resize();
    this.ui.toast(`Quality: ${preset.label}`);
  }

  _resize() {
    const preset = presetFor(this.s.quality);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this._pixelRatio(preset));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.controls.applyLayout();
  }

  /* --------------------------------------------------------------- loop */

  _loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += dt;

    this.controls.decay(dt);
    this.player.camYaw = this.follow.yaw;
    this.player.update(dt, this.controls);
    this.follow.update(dt, this.player, this.controls.takeCamera(), this.s);
    this.world.update(dt, this.elapsed, this.player.position);
    if (this.courseActive !== false) this._checkRings(dt);

    // idle swing on the rings
    for (const r of this.ringNodes) {
      if (r.taken) continue;
      r.node.rotation.y += r.spin * dt;
      r.node.position.y = r.baseY + Math.sin(this.elapsed * 1.6 + r.baseY) * 0.12;
    }
    if (this.ringPulse > 0) {
      this.ringPulse = Math.max(0, this.ringPulse - dt * 2.5);
      this.camera.fov = 55 + this.ringPulse * 4;
      this.camera.updateProjectionMatrix();
    }

    // adaptive resolution
    if (this.governor.update(dt)) this._resize();

    this.ui.setTime(this._clockString());
    this._fpsTimer += dt; this._fpsFrames++;
    if (this._fpsTimer >= 0.5) {
      this.ui.setFps(Math.round(this._fpsFrames / this._fpsTimer));
      this._fpsTimer = 0; this._fpsFrames = 0;
    }

    this.renderer.render(this.scene, this.camera);
  };

  _clockString() {
    const t = this.world.time;
    const hh = Math.floor(t) % 24;
    const mm = Math.floor((t % 1) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }
}

export function start() {
  const game = new Game();
  game.init().catch(err => {
    console.error(err);
    const el = document.getElementById('loadText');
    if (el) el.textContent = 'Could not start: ' + (err && err.message ? err.message : err);
  });
  window.game = game;
  return game;
}

export { guessPreset };
