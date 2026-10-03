/**
 * HUD, settings panel and the drag-to-place layout editor.
 */

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(settings, callbacks) {
    this.s = settings;
    this.cb = callbacks || {};
    this.panel = $('panel');
    this.panelOpen = false;
    this._bindSliders();
    this._bindButtons();
    this.syncAll();
  }

  /* ------------------------------------------------------------ helpers */

  setSlider(key, value) {
    document.querySelectorAll(`input[data-k="${key}"]`).forEach(i => { i.value = value; });
    document.querySelectorAll(`[data-v="${key}"]`).forEach(el => { el.textContent = this._fmt(key); });
  }

  _fmt(key) {
    const s = this.s;
    switch (key) {
      case 'joySize': return Math.round(s.joy.size) + 'px';
      case 'btnSize': return Math.round(s.btn.size) + 'px';
      case 'opacity': return Math.round(s.opacity * 100) + '%';
      case 'camDist': return s.camDistance.toFixed(1) + ' m';
      case 'camSens': return s.camSens.toFixed(2) + '×';
      default: return '';
    }
  }

  syncAll() {
    this.setSlider('joySize', this.s.joy.size);
    this.setSlider('btnSize', this.s.btn.size);
    this.setSlider('opacity', Math.round(this.s.opacity * 100));
    this.setSlider('camDist', this.s.camDistance);
    this.setSlider('camSens', this.s.camSens);
    const q = $('btnQuality');
    if (q) q.textContent = this.s.quality === 'auto' ? 'Auto' : this.s.quality[0].toUpperCase() + this.s.quality.slice(1);
    const h = $('btnHanded');
    if (h) h.textContent = this.s.handedness === 'right' ? 'Stick: left' : 'Stick: right';
    const sp = $('btnSprintMode');
    if (sp) sp.textContent = this.s.sprint === 'push' ? 'Run: joystick' : 'Run: button';
    this.toggle('btnShadows', this.s.shadows);
    this.toggle('btnDayCycle', this.s.dayCycle);
    this.toggle('btnAutoAlign', this.s.autoAlign);
    this.toggle('btnInvertY', this.s.invertY);
    this.toggle('btnSfx', this.s.sfx);
    this.toggle('btnHaptics', this.s.haptics);
    this.toggle('btnFps', this.s.showFps);
    const t = $('timeSlider');
    if (t) t.value = this.s.time;
    const sh = $('sunSlider');
    if (sh) sh.value = this.s.sunHeight;
  }

  toggle(id, on) {
    const el = $(id);
    if (el) el.classList.toggle('on', !!on);
  }

  /* ------------------------------------------------------------- wiring */

  _bindSliders() {
    const map = {
      joySize: (v) => { this.s.joy.size = v; },
      btnSize: (v) => { this.s.btn.size = v; },
      opacity: (v) => { this.s.opacity = v / 100; },
      camDist: (v) => { this.s.camDistance = v; },
      camSens: (v) => { this.s.camSens = v; }
    };
    document.querySelectorAll('input[data-k]').forEach(input => {
      const key = input.dataset.k;
      const apply = map[key];
      if (!apply) return;
      input.addEventListener('input', () => {
        apply(parseFloat(input.value));
        this.setSlider(key, input.value);
        this.cb.onLayout && this.cb.onLayout();
        this.cb.onSettings && this.cb.onSettings();
      });
    });
    const timeSlider = $('timeSlider');
    if (timeSlider) {
      timeSlider.addEventListener('input', () => {
        this.s.time = parseFloat(timeSlider.value);
        const t = $('timeVal');
        if (t) {
          const hh = Math.floor(this.s.time) % 24;
          const mm = Math.floor((this.s.time % 1) * 60);
          t.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
        }
        this.cb.onSettings && this.cb.onSettings();
      });
    }
    const sunSlider = $('sunSlider');
    if (sunSlider) {
      sunSlider.addEventListener('input', () => {
        this.s.sunHeight = parseFloat(sunSlider.value);
        this.cb.onSettings && this.cb.onSettings();
      });
    }
  }

  _bindButtons() {
    const on = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener('click', () => { fn(el); });
    };
    on('btnGear', () => this.setPanel(!this.panelOpen));
    on('btnPanelClose', () => this.setPanel(false));
    on('btnEdit', () => { this.setPanel(false); this.cb.onEdit && this.cb.onEdit(true); });
    on('btnEditDone', () => this.cb.onEdit && this.cb.onEdit(false));
    on('btnReset', () => { this.cb.onReset && this.cb.onReset(); this.syncAll(); });
    on('btnResetLayout2', () => { this.cb.onReset && this.cb.onReset(); this.syncAll(); });
    on('btnQuality', () => {
      const order = ['auto', 'low', 'medium', 'high'];
      this.s.quality = order[(order.indexOf(this.s.quality) + 1) % order.length];
      this.cb.onQuality && this.cb.onQuality();
      this.syncAll();
    });
    on('btnHanded', () => {
      this.s.handedness = this.s.handedness === 'right' ? 'left' : 'right';
      this.cb.onLayout && this.cb.onLayout();
      this.syncAll();
    });
    on('btnSprintMode', () => {
      this.s.sprint = this.s.sprint === 'push' ? 'button' : 'push';
      document.body.classList.toggle('sprint-button', this.s.sprint === 'button');
      this.cb.onLayout && this.cb.onLayout();
      this.syncAll();
    });
    const flips = {
      btnShadows: 'shadows', btnDayCycle: 'dayCycle', btnAutoAlign: 'autoAlign',
      btnInvertY: 'invertY', btnSfx: 'sfx', btnHaptics: 'haptics', btnFps: 'showFps'
    };
    for (const [id, key] of Object.entries(flips)) {
      on(id, (el) => {
        this.s[key] = !this.s[key];
        this.toggle(id, this.s[key]);
        this.cb.onSettings && this.cb.onSettings();
      });
    }
    on('btnBalls', () => this.cb.onBalls && this.cb.onBalls());
    on('btnFullscreen', () => this.cb.onFullscreen && this.cb.onFullscreen());
    on('btnCheer', () => this.cb.onCheer && this.cb.onCheer());
    document.querySelectorAll('[data-time]').forEach(b => {
      b.addEventListener('click', () => {
        this.s.time = parseFloat(b.dataset.time);
        const t = $('timeSlider');
        if (t) t.value = this.s.time;
        const hv = $('timeVal');
        if (hv) {
          const hh = Math.floor(this.s.time) % 24;
          const mm = Math.floor((this.s.time % 1) * 60);
          hv.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
        }
        this.cb.onSettings && this.cb.onSettings();
      });
    });
  }

  setPanel(open) {
    this.panelOpen = open;
    this.panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('panel-open', open);
  }

  setLoading(progress, text) {
    const bar = $('loadBar');
    const label = $('loadText');
    if (bar) bar.style.width = Math.round(progress * 100) + '%';
    if (label && text) label.textContent = text;
  }

  hideLoader() {
    const l = $('loader');
    if (!l) return;
    l.classList.add('done');
    setTimeout(() => l.remove(), 700);
  }

  /* ------------------------------------------------------------ gameplay */

  setTime(hhmm) {
    const el = $('clock');
    if (el) el.textContent = hhmm;
  }

  setRings(n) {
    const el = $('rings');
    if (el) el.textContent = n;
  }

  toast(msg, ms = 1800) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  setFps(v) {
    const el = $('fps');
    if (!el) return;
    el.textContent = v;
    el.style.display = this.s.showFps ? 'block' : 'none';
  }

  showResult(rings, best, isBest) {
    const el = $('result');
    if (!el) return;
    $('resultRings').textContent = rings;
    $('resultBest').textContent = isBest ? 'New best!' : `Best: ${best}`;
    el.classList.add('show');
  }
  hideResult() {
    const el = $('result');
    if (el) el.classList.remove('show');
  }
}
