/**
 * Quality presets + adaptive performance governor.
 *
 * Mobile GPUs are wildly different, so the game never trusts a static preset:
 * it keeps a rolling frame-time average and shrinks the render resolution
 * (and if needed the shadow map) until the frame rate is stable.
 */

export const PRESETS = {
  low: {
    label: 'Low', dpr: 0.85, antialias: false, shadows: false, shadowSize: 512,
    grass: 220, clouds: 4, fireflies: 0, ballLimit: 12, pixelBudget: 0.9e6
  },
  medium: {
    label: 'Medium', dpr: 1.0, antialias: false, shadows: true, shadowSize: 768,
    grass: 480, clouds: 6, fireflies: 140, ballLimit: 18, pixelBudget: 1.8e6
  },
  high: {
    label: 'High', dpr: 1.5, antialias: true, shadows: true, shadowSize: 1024,
    grass: 850, clouds: 7, fireflies: 260, ballLimit: 24, pixelBudget: 3.2e6
  }
};

/** Rough device tier guess — used once at boot for the 'auto' preset. */
export function guessPreset() {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency || (mobile ? 4 : 8);
  const mem = navigator.deviceMemory || 4;
  let score = 0;
  score += Math.min(cores, 10) * 2;
  score += Math.min(mem, 8);
  if (!mobile) score += 8;
  if (score >= 26) return 'high';
  if (score >= 16) return 'medium';
  return 'low';
}

export function presetFor(name) {
  if (name === 'auto') return PRESETS[guessPreset()];
  return PRESETS[name] || PRESETS.medium;
}

export class PerformanceGovernor {
  constructor() {
    this.scale = 1;                 // dynamic resolution multiplier (0.55 .. 1)
    this.frameMs = 16.7;
    this.fps = 60;
    this._acc = 0; this._frames = 0; this._cooldown = 1.2; this._good = 0;
    this.enabled = true;
    this.stats = { drops: 0, raises: 0 };
  }

  reset(frameMs = 16.7) {
    this.frameMs = frameMs; this._acc = 0; this._frames = 0;
    this._cooldown = 1.2; this._good = 0;
  }

  /** Returns true when the render scale changed (caller must resize). */
  update(dt) {
    this._acc += dt; this._frames++;
    if (this._cooldown > 0) this._cooldown -= dt;
    // exponential average over ~0.5 s
    this.frameMs += ((dt * 1000) - this.frameMs) * 0.08;
    if (this._acc >= 0.5) {
      this.fps = this._frames / this._acc;
      this._acc = 0; this._frames = 0;
    }
    if (!this.enabled || this._cooldown > 0) return false;

    const slow = this.frameMs > 21.5;    // below ~46 fps
    const fast = this.frameMs < 14.2;    // above ~70 fps
    const before = this.scale;
    if (slow && this.scale > 0.55) {
      this.scale = Math.max(0.55, this.scale - 0.08);
      this.stats.drops++;
      this._cooldown = 1.6;
      this.reset(Math.min(this.frameMs, 22));
    } else if (fast && this.scale < 1) {
      this._good += 0.5;
      if (this._good > 2.5) {
        this._good = 0;
        this.scale = Math.min(1, this.scale + 0.05);
        this.stats.raises++;
        this._cooldown = 1.6;
      }
    } else {
      this._good = 0;
    }
    return this.scale !== before;
  }
}
