/**
 * Touch input: virtual joystick, jump / sprint buttons, camera drag and the
 * drag-to-place layout editor.
 *
 * Everything is pointer-event based with per-control pointer capture so the
 * player can steer and jump at the same time on a real touchscreen.
 */

const $ = (id) => document.getElementById(id);

export class Controls {
  /**
   * @param {object} opts
   *   settings   live settings object (mutated by the editor + panel)
   *   onChange   called whenever the layout settings change (to persist)
   */
  constructor(settings, onChange) {
    this.s = settings;
    this.onChange = onChange || (() => {});
    this.move = { x: 0, y: 0, mag: 0 };     // -1..1, mag 0..1
    this.jumpQueued = 0;
    this.jumpHeld = false;
    this.sprintHeld = false;
    this.camera = { dx: 0, dy: 0 };
    this.editing = false;
    this.dragging = null;
    this._keys = Object.create(null);

    this.joy = $('joy');
    this.knob = $('knob');
    this.btnJump = $('btnJump');
    this.btnSprint = $('btnSprint');
    this.stickId = null;
    this.jumpId = null;
    this.sprintId = null;
    this.camId = null;
    this.camLast = { x: 0, y: 0 };
    this.surface = $('scene');

    this._bindJoystick();
    this._bindButton(this.btnJump, 'jump');
    this._bindButton(this.btnSprint, 'sprint');
    this._bindCamera();
    this._bindKeyboard();
    this.applyLayout();
  }

  /* ------------------------------------------------------------- layout */

  applyLayout() {
    const s = this.s;
    const joySize = s.joy.size, btnSize = s.btn.size;
    const flip = s.handedness === 'left';
    const joy = flip
      ? (s.joySwap || { x: 1 - s.joy.x, y: s.joy.y })
      : s.joy;
    // the joystick keeps its own anchor; the jump button mirrors with handedness
    const jp = { x: flip ? Math.max(0.12, 1 - s.joy.x) : s.joy.x, y: s.joy.y };
    const bp = { x: flip ? Math.min(0.88, 1 - s.btn.x) : s.btn.x, y: s.btn.y };

    const place = (el, p, size) => {
      el.style.width = el.style.height = size + 'px';
      el.style.left = (p.x * innerWidth - size / 2) + 'px';
      el.style.top = (p.y * innerHeight - size / 2) + 'px';
      el.style.opacity = this.editing ? 1 : s.opacity;
      // font scales with the button so labels stay readable at any size
      el.style.fontSize = Math.max(11, Math.round(size * 0.16)) + 'px';
    };
    place(this.joy, jp, joySize);
    place(this.btnJump, bp, btnSize);
    if (this.btnSprint) {
      const sp = { x: bp.x, y: bp.y - (btnSize * 1.15) / innerHeight };
      place(this.btnSprint, sp, btnSize * 0.74);
    }
    this.joyPos = jp;
    this.btnPos = bp;
  }

  setEditing(on) {
    this.editing = on;
    document.body.classList.toggle('editing', on);
    if (!on) {
      this.move.x = this.move.y = this.move.mag = 0;
      this.knob.style.transform = '';
    }
    this.applyLayout();
  }

  /* ---------------------------------------------------------- joystick */

  _bindJoystick() {
    const joy = this.joy;
    const stick = (e) => {
      const r = joy.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - r.left - R) / R;
      let dy = (e.clientY - r.top - R) / R;
      const len = Math.hypot(dx, dy);
      const clamped = Math.min(1, len);
      if (len > 1) { dx /= len; dy /= len; }
      this.move.x = dx; this.move.y = -dy; this.move.mag = clamped;
      this.knob.style.transform = `translate(${dx * R * 0.52}px,${dy * R * 0.52}px)`;
    };
    joy.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      joy.setPointerCapture(e.pointerId);
      if (this.editing) { this.dragging = { what: 'joy', id: e.pointerId }; return; }
      this.stickId = e.pointerId;
      joy.classList.add('active');
      stick(e);
    }, { passive: false });
    joy.addEventListener('pointermove', (e) => {
      if (this.dragging && this.dragging.what === 'joy' && e.pointerId === this.dragging.id) {
        this._dragPlace('joy', e);
      } else if (e.pointerId === this.stickId) {
        stick(e);
      }
    });
    const end = (e) => {
      if (this.dragging && e.pointerId === this.dragging.id) { this.dragging = null; this.onChange(true); return; }
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.move.x = this.move.y = this.move.mag = 0;
      this.knob.style.transform = '';
      joy.classList.remove('active');
    };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
    joy.addEventListener('lostpointercapture', end);
  }

  _dragPlace(what, e) {
    const r = (what === 'joy' ? this.joy : this.btnJump).getBoundingClientRect();
    const key = what === 'joy' ? 'joy' : 'btn';
    const x = Math.min(0.94, Math.max(0.06, e.clientX / innerWidth));
    const y = Math.min(0.94, Math.max(0.06, e.clientY / innerHeight));
    this.s[key].x = x; this.s[key].y = y;
    this.applyLayout();
  }

  /* ------------------------------------------------------------ buttons */

  _bindButton(el, kind) {
    if (!el) return;
    const down = (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (this.editing) {
        if (kind === 'sprint') return;    // the sprint button follows the jump button
        this.dragging = { what: 'btn', id: e.pointerId };
        return;
      }
      el.classList.add('down');
      if (kind === 'jump') {
        this.jumpQueued = 0.2;
        this.jumpHeld = true;
        if (navigator.vibrate && this.s.haptics) navigator.vibrate(12);
      } else {
        this.sprintHeld = true;
      }
    };
    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointermove', (e) => {
      if (this.dragging && this.dragging.what === 'btn' && e.pointerId === this.dragging.id) this._dragPlace('btn', e);
    });
    const up = (e) => {
      el.classList.remove('down');
      if (this.dragging && e.pointerId === this.dragging.id) { this.dragging = null; this.onChange(true); return; }
      if (kind === 'jump') this.jumpHeld = false; else this.sprintHeld = false;
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
  }

  /* ------------------------------------------------------------- camera */

  _bindCamera() {
    const c = this.surface;
    c.addEventListener('pointerdown', (e) => {
      if (this.editing || this.camId !== null) return;
      this.camId = e.pointerId;
      this.camLast.x = e.clientX; this.camLast.y = e.clientY;
      document.body.classList.add('dragging-cam');
    }, { passive: true });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.camId) return;
      const sens = 0.0042 * (this.s.camSens || 1);
      this.camera.dx += (e.clientX - this.camLast.x) * sens;
      this.camera.dy += (e.clientY - this.camLast.y) * sens * (this.s.invertY ? -1 : 1);
      this.camLast.x = e.clientX; this.camLast.y = e.clientY;
    }, { passive: true });
    const end = (e) => {
      if (e.pointerId === this.camId) { this.camId = null; document.body.classList.remove('dragging-cam'); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => { this.camId = null; this.stickId = null; this.move.mag = 0; });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  /** Keyboard fallback so the game is also playable on desktop browsers. */
  _bindKeyboard() {
    const k = this._keys;
    addEventListener('keydown', (e) => {
      k[e.code] = 1;
      if (e.code === 'Space') { this.jumpQueued = 0.2; this.jumpHeld = true; e.preventDefault(); }
    });
    addEventListener('keyup', (e) => {
      k[e.code] = 0;
      if (e.code === 'Space') this.jumpHeld = false;
    });
  }

  /** Consume per-frame camera deltas. */
  takeCamera() {
    const d = { dx: this.camera.dx, dy: this.camera.dy };
    this.camera.dx = this.camera.dy = 0;
    return d;
  }

  /** Axis + magnitude, including the keyboard fallback. */
  vector() {
    let x = this.move.x, y = this.move.y, mag = this.move.mag;
    const k = this._keys;
    const kx = (k['KeyD'] || k['ArrowRight'] ? 1 : 0) - (k['KeyA'] || k['ArrowLeft'] ? 1 : 0);
    const ky = (k['KeyW'] || k['ArrowUp'] ? 1 : 0) - (k['KeyS'] || k['ArrowDown'] ? 1 : 0);
    if (kx || ky) {
      const l = Math.hypot(kx, ky);
      x = kx / l; y = ky / l; mag = 1;
    }
    return { x, y, mag, sprint: this.sprintHeld || !!(k['ShiftLeft'] || k['ShiftRight']) };
  }

  takeJump() {
    if (this.jumpQueued > 0) { this.jumpQueued = 0; return true; }
    return false;
  }
  decay(dt) {
    this.jumpQueued = Math.max(0, this.jumpQueued - dt);
  }
}
