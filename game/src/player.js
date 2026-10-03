/**
 * Player: movement, jumping, ball kicking and animation state.
 *
 * The character controller is intentionally simple and predictable — a capsule
 * that slides along the ground, with the animation layer driven by speed so
 * walk <-> run <-> jump blend smoothly on a small screen.
 */

import * as THREE from 'three';

const WALK_SPEED = 1.75;      // m/s — matches the walk cycle's stride rate
const RUN_SPEED = 5.2;        // m/s
const WALK_THRESHOLD = 0.55;  // joystick magnitude where the run starts
const GRAVITY = -17;
const JUMP_VELOCITY = 5.5;
const TURN_RATE = 12;         // rad/s

export class Player {
  constructor(hero, playground, sfx) {
    this.hero = hero;
    this.world = playground;
    this.sfx = sfx;
    this.position = hero.root.position;
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.vertical = 0;            // jump height above ground
    this.vy = 0;
    this.airborne = false;
    this.state = 'idle';
    this.phase = 0;
    this.weights = { idle: 1, walk: 0, run: 0, jump: 0 };
    this.speed = 0;
    this.jumpCoyote = 0;
    this.landed = 0;
    this.radius = 0.32;
    this._tmp = new THREE.Vector3();
    this._dust = null;
    this._buildDust();
  }

  _buildDust() {
    // a small ring of quads used as a landing puff / footstep dust
    const N = 12;
    const geo = new THREE.PlaneGeometry(0.34, 0.34);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xf3e6c8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide
    });
    this.dust = new THREE.InstancedMesh(geo, mat, N);
    this.dust.frustumCulled = false;
    this.dust.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dustSeeds = [];
    for (let i = 0; i < N; i++) {
      this.dustSeeds.push({ a: (i / N) * Math.PI * 2, r: 0.16 + Math.random() * 0.2, life: 0, s: 1 });
    }
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    this._v3 = new THREE.Vector3();
    this._s3 = new THREE.Vector3(1, 1, 1);
    this.dustActive = 0;
    this.hero.root.parent.add(this.dust);
  }

  puff(strength = 1) {
    this.dustActive = 1;
    this.dustStrength = strength;
    for (const s of this.dustSeeds) s.s = 0.4 + Math.random() * 0.9;
  }

  /** Balls get pushed when the player walks into them. */
  _kickBalls(dt) {
    const balls = this.world.balls;
    if (!balls.length) return;
    for (const b of balls) {
      const dx = b.mesh.position.x - this.position.x;
      const dz = b.mesh.position.z - this.position.z;
      const d = Math.hypot(dx, dz);
      const min = b.r + this.radius + 0.05;
      if (d < min && d > 1e-4 && Math.abs(b.mesh.position.y - b.r) < 0.8) {
        const nx = dx / d, nz = dz / d;
        b.mesh.position.x = this.position.x + nx * min;
        b.mesh.position.z = this.position.z + nz * min;
        b.vel.x += nx * (2.2 + this.speed * 0.5);
        b.vel.z += nz * (2.2 + this.speed * 0.5);
        b.vel.y = Math.max(b.vel.y, 1.4);
        if (this.sfx) this.sfx.bounce();
      }
    }
  }

  update(dt, input) {
    const v = input.vector();
    const mag = v.mag < 0.08 ? 0 : Math.min(1, v.mag);

    // move relative to the camera yaw
    const camYaw = this.camYaw || 0;
    let wishX = 0, wishZ = 0;
    if (mag > 0) {
      const len = Math.hypot(v.x, v.y) || 1;
      const ix = v.x / len, iy = v.y / len;
      wishX = -Math.sin(camYaw) * iy + Math.cos(camYaw) * ix;
      wishZ = -Math.cos(camYaw) * iy - Math.sin(camYaw) * ix;
    }

    const wantsRun = v.sprint || mag > WALK_THRESHOLD || (this.mode === 'run' && mag > 0.35);
    const targetSpeed = mag === 0 ? 0 : (wantsRun ? RUN_SPEED : WALK_SPEED);

    // acceleration depends on whether we're steering or braking
    const accel = this.airborne ? 6 : (targetSpeed > 0 ? 16 : 14);
    const tx = wishX * targetSpeed, tz = wishZ * targetSpeed;
    const k = 1 - Math.exp(-dt * accel);
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.world.collide(this.position, this.radius);
    this._kickBalls(dt);

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // face the direction of travel
    if (this.speed > 0.35) {
      const target = Math.atan2(this.velocity.x, this.velocity.z);
      let d = target - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * TURN_RATE);
    }
    this.hero.root.rotation.y = this.yaw;

    // jump
    if (this.jumpCoyote > 0) this.jumpCoyote -= dt;
    if (input.takeJump()) {
      if (!this.airborne) {
        this.vy = JUMP_VELOCITY;
        this.airborne = true;
        this.jumpCoyote = 0;
        if (this.sfx) this.sfx.jump();
        this._playJump();
      } else {
        this.jumpCoyote = 0.22;   // buffer a jump for the landing
      }
    }
    if (this.airborne) {
      this.vy += GRAVITY * dt;
      this.vertical += this.vy * dt;
      if (this.vertical <= 0) {
        const impact = Math.min(1, -this.vy / 7);
        this.vertical = 0;
        this.vy = 0;
        this.airborne = false;
        this.puff(impact);
        if (this.sfx && impact > 0.25) this.sfx.land();
        if (this.jumpCoyote > 0) {
          this.jumpCoyote = 0;
          this.vy = JUMP_VELOCITY * 0.9;
          this.airborne = true;
          this._playJump();
        }
      }
    }
    this.hero.root.position.y = this.vertical;

    this._updateAnim(dt, mag, wantsRun);

    // dust
    if (this.dustActive > 0) {
      this.dustActive = Math.max(0, this.dustActive - dt * 2.2);
      const t = 1 - this.dustActive;
      for (let i = 0; i < this.dustSeeds.length; i++) {
        const s = this.dustSeeds[i];
        const r = s.r * (1 + t * 2.6);
        this._v3.set(
          this.position.x + Math.cos(s.a) * r,
          0.04 + t * 0.12,
          this.position.z + Math.sin(s.a) * r
        );
        this._s3.setScalar((0.5 + t * 0.9) * s.s);
        this._m4.compose(this._v3, this._q, this._s3);
        this.dust.setMatrixAt(i, this._m4);
      }
      this.dust.instanceMatrix.needsUpdate = true;
      this.dust.material.opacity = this.dustActive * 0.5 * (this.dustStrength || 1);
    } else if (this.dust.material.opacity !== 0) {
      this.dust.material.opacity = 0;
    }
  }

  _playJump() {
    const a = this.hero.actions;
    if (!a.jump) { this.state = 'jumpPending'; return; }
    this.jumping = true;
    this.jumpTime = 0;
    a.jump.reset();
    a.jump.setEffectiveTimeScale(1);
    a.jump.play();
  }

  _updateAnim(dt, mag, wantsRun) {
    const a = this.hero.actions;
    const durations = this.hero.durations;

    let target;
    if (this.airborne) target = 'jump';
    else if (mag < 0.08) target = 'idle';
    else target = wantsRun ? 'run' : 'walk';

    // airborne: play the jump clip once, synced so the crouch/landing reads
    if (this.airborne) {
      if (a.jump) {
        const t = a.jump.time;
        // hold the launch pose while rising, then let the clip run into the landing
        const wantTime = Math.min(durations.jump - 0.001, 0.28 + (1.1 - Math.min(1.1, this.vy / JUMP_VELOCITY)) * 0.45);
        const t2 = t + (wantTime - t) * Math.min(1, dt * 10);
        a.jump.time = Math.max(0, Math.min(durations.jump - 0.001, t2));
      }
    }

    this.state = target;
    const speeds = { idle: 12, walk: 10, run: 10, jump: this.airborne ? 16 : 12 };
    for (const key of ['idle', 'walk', 'run', 'jump']) {
      if (!a[key]) continue;
      const goal = key === target ? 1 : 0;
      this.weights[key] += (goal - this.weights[key]) * (1 - Math.exp(-dt * speeds[key]));
      if (this.weights[key] < 0.001) this.weights[key] = 0;
      a[key].setEffectiveWeight(this.weights[key]);
    }

    // stride phase advance — keeps feet sliding to a minimum
    if (target === 'walk' || target === 'run') {
      const perMetre = target === 'run' ? 1 / 3.29 : 1 / 1.752;
      this.phase = (this.phase + dt * this.speed * perMetre) % 1;
      if (a.walk) a.walk.time = target === 'walk' ? this.phase * durations.walk : 0;
      if (a.run) {
        // offset the run clip so its footstrike lines up with the walk's
        const off = 0.935;
        a.run.time = target === 'run' ? ((this.phase + off) % 1) * durations.run : 0;
      }
    }
    if (this.speed > 0.2 && !this.airborne) {
      const stride = this.state === 'run' ? 0.36 : 0.46;
      this._stepAcc = (this._stepAcc || 0) + this.speed * dt;
      if (this._stepAcc > stride) {
        this._stepAcc = 0;
        if (this.hero.mesh.castShadow) this.puff(0.25);
      }
    }
  }
}

/**
 * Third-person follow camera with drag-to-orbit and automatic re-centring
 * behind the player while running (optional).
 */
export class FollowCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = Math.PI;
    this.pitch = 0.34;
    this.distance = 5.4;
    this.targetDistance = 5.4;
    this.autoAlign = true;
    this.sens = 1;
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this.initialised = false;
  }

  reset(playerYaw) {
    this.yaw = playerYaw + Math.PI;
    this.pitch = 0.34;
  }

  update(dt, player, camInput, settings) {
    this.autoAlign = settings.autoAlign;
    const sens = settings.camSens || 1;
    this.yaw -= camInput.dx * sens;
    this.pitch = Math.max(-0.15, Math.min(1.22, this.pitch + camInput.dy * sens * 0.8));
    this.targetDistance = settings.camDistance;

    // re-centre behind the player when moving forward and not touching the camera
    if (this.autoAlign && Math.abs(camInput.dx) < 1e-4 && player.speed > 2.2) {
      const behind = player.yaw + Math.PI;
      let d = behind - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 0.9);
    }

    this.distance += (this.targetDistance - this.distance) * Math.min(1, dt * 6);
    const height = 1.35 + Math.sin(this.pitch) * this.distance * (settings.camHeight || 0.34) * 3;
    this._target.set(player.position.x, 1.3 + player.vertical * 0.65, player.position.z);
    this._desired.set(
      this._target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance,
      Math.max(0.45, this._target.y + Math.sin(this.pitch) * this.distance),
      this._target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance
    );
    if (!this.initialised) {
      this.camera.position.copy(this._desired);
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-dt * 14);
      this.camera.position.lerp(this._desired, k);
    }
    this.camera.lookAt(this._target);
  }
}
