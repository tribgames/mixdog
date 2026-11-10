import { readSection } from '../../shared/config.mjs';
import { listSchedules } from './schedules-db.mjs';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
const DATA_DIR = resolvePluginData();
const DEFAULT_CONFIG = {};
// Shared defaults layer. Merge semantics: user values win; defaults
// only fill missing fields. Helper is exported so the setup UI and
// runtime both produce the same shape when the file has missing sections.
const CONFIG_DEFAULTS = {
  webhook: { enabled: true },
};
function applyDefaults(config) {
  const out = { ...(config || {}) };
  out.webhook = { ...CONFIG_DEFAULTS.webhook, ...(out.webhook || {}) };
  return out;
}

async function loadConfig() {
  try {
    let raw = readSection('channels');
    raw = raw && typeof raw === 'object' ? raw : {};
    // Schedules are the PG `scheduler.schedules` table (single source of
    // truth); the config file holds no schedules. Done one-shots are dropped
    // so they never re-arm. Every schedule fires as a visible session run
    // (runScheduleSession).
    raw.schedules = (await listSchedules()).filter((s) => s.enabled !== false && s.status !== 'done');
    // voice config lives at the top level of mixdog-config.json (peer of
    // channels), so readSection("channels") never sees it. Pull it explicitly.
    let voice = {};
    try {
      const v = readSection('voice');
      if (v && typeof v === 'object') voice = v;
    } catch {
      /* missing section is fine */
    }
    return applyDefaults({
      ...DEFAULT_CONFIG,
      ...raw,
      voice: { ...(raw.voice || {}), ...voice },
    });
  } catch (err) {
    // Defaults live in code; a missing config is never written back.
    if (err.code === 'ENOENT') return applyDefaults(DEFAULT_CONFIG);
    throw err;
  }
}
export { DATA_DIR, loadConfig };
