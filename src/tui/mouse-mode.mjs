/**
 * src/tui/mouse-mode.mjs — runtime source of truth for the TUI mouse mode.
 *
 * Two modes:
 *   • 'app'    — mixdog owns SGR mouse tracking (in-app selection, wheel scroll).
 *   • 'native' — mouse capture is released so the terminal (e.g. Windows
 *                Terminal) owns selection/copy/double-click natively; wheel
 *                scrolling still reaches the transcript via alternate-scroll
 *                (DECSET 1007) arrow bursts routed by use-native-scroll-router.
 *
 * Mirrors theme.mjs: a tiny in-process singleton plus lazy, dist-aware
 * persistence under `ui.mouseMode` in mixdog-config.json. Kept free of a static
 * config dependency so importing this module never drags the keychain in.
 */

let _mouseMode = 'app';

/** Active mouse mode ('app' | 'native'). */
export function getMouseModeSetting() {
  return _mouseMode;
}

/**
 * Coerce any value to a mode. Accepts toggle synonyms:
 *   native/terminal/off/0/false/no  → 'native'
 *   app/on/1/true/yes               → 'app'
 * Returns null for anything unrecognized so callers can reject bad input.
 */
export function resolveMouseMode(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (['native', 'terminal', 'off', '0', 'false', 'no'].includes(key)) return 'native';
  if (['app', 'on', '1', 'true', 'yes'].includes(key)) return 'app';
  return null;
}

/**
 * Set the active mode. Persists `ui.mouseMode` unless `persist` is false.
 * Returns the resolved mode ('app' | 'native').
 */
export function setMouseModeSetting(mode, { persist = true } = {}) {
  const next = mode === 'native' ? 'native' : 'app';
  _mouseMode = next;
  if (persist) void persistMouseMode(next);
  return _mouseMode;
}

// ── Persistence (lazy, dist-aware) — same shape as theme.mjs ────────────────
const CONFIG_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../runtime/shared/config.mjs'
  : '../runtime/shared/config.mjs';
let _configModulePromise = null;
function loadConfigModule() {
  if (!_configModulePromise) _configModulePromise = import(CONFIG_MODULE);
  return _configModulePromise;
}

async function persistMouseMode(mode) {
  try {
    const { updateConfig } = await loadConfigModule();
    updateConfig((cfg) => {
      const ui = cfg && typeof cfg.ui === 'object' && cfg.ui ? cfg.ui : {};
      return { ...cfg, ui: { ...ui, mouseMode: mode } };
    });
  } catch {
    // Best-effort: a missing/locked config must never crash the TUI.
  }
}

/**
 * Read `ui.mouseMode` from mixdog-config.json and apply it (no re-persist).
 * Safe to call once at boot; returns the resolved active mode. Unknown/missing
 * values leave the default ('app') in place.
 */
export async function loadMouseModeFromConfig() {
  try {
    const { readConfig } = await loadConfigModule();
    const cfg = readConfig() || {};
    const stored = cfg && cfg.ui && typeof cfg.ui === 'object' ? cfg.ui.mouseMode : null;
    const resolved = resolveMouseMode(stored);
    if (resolved) _mouseMode = resolved;
  } catch {
    // Fall back to the already-applied default mode.
  }
  return _mouseMode;
}
