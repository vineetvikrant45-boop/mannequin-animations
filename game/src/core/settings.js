/**
 * Persistent settings — everything the player can tune lives here.
 * Stored in localStorage so it survives app restarts.
 */

const KEY = 'mpg_settings_v1';

export const DEFAULTS = {
  joy: { x: 0.17, y: 0.72, size: 152 },   // normalized screen position + px size
  btn: { x: 0.84, y: 0.70, size: 112 },
  opacity: 0.85,
  handedness: 'right',        // 'right' | 'left'  (left = joystick on the right)
  sprint: 'push',             // 'push' (joystick far = run) | 'button'
  camDistance: 5.4,
  camHeight: 0.34,
  camSens: 1.0,
  invertY: false,
  autoAlign: true,
  quality: 'auto',            // 'auto' | 'low' | 'medium' | 'high'
  shadows: true,
  dayCycle: false,
  time: 14,
  sunHeight: 0.62,
  sfx: true,
  haptics: true,
  showFps: false
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const b = base[k], p = patch[k];
    if (b && p && typeof b === 'object' && typeof p === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b, p);
    } else if (p !== undefined) {
      out[k] = p;
    }
  }
  return out;
}

export function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
  return deepMerge(DEFAULTS, saved);
}

let saveTimer = 0;
export function saveSettings(s) {
  // debounce: slider drags fire a lot of events
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }, 180);
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}

/** Records (best times) are stored separately so "reset settings" keeps them. */
const REC_KEY = 'mpg_records_v1';
export function loadRecords() {
  try { return JSON.parse(localStorage.getItem(REC_KEY) || '{}'); } catch (e) { return {}; }
}
export function saveRecords(r) {
  try { localStorage.setItem(REC_KEY, JSON.stringify(r)); } catch (e) { /* ignore */ }
}
