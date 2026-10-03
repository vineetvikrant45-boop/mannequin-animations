/**
 * Tiny WebAudio SFX kit — synthesised, so the APK ships no audio assets and
 * there is nothing to decode at load time.
 */

export class Sfx {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
    this.master = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
  }

  /** Must be called from a user gesture on mobile. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.5 : 0;
    this.master.connect(this.ctx.destination);
  }

  _tone(freq, dur, type = 'sine', gain = 0.25, slide = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  _noise(dur, gain = 0.18, filterHz = 900) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterHz;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
  }

  jump()     { this._tone(320, 0.22, 'triangle', 0.22, 260); }
  land()     { this._noise(0.16, 0.22, 500); }
  ring(n)    { this._tone(660 + n * 90, 0.18, 'sine', 0.3, 120); setTimeout(() => this._tone(990 + n * 120, 0.22, 'sine', 0.22), 70); }
  finish()   { [0, 1, 2, 3].forEach(i => setTimeout(() => this._tone(523 * Math.pow(1.26, i), 0.35, 'triangle', 0.26), i * 120)); }
  ui()       { this._tone(880, 0.05, 'square', 0.06); }
  bounce()   { this._tone(180, 0.09, 'sine', 0.16, -60); }
}
