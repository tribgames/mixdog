// builtin-grandfathering.mjs — dependency-free install-marker helpers shared by
// the orchestrator's builtin-features and the defaults migration.

const GRANDFATHERED_BUILTIN_IDS = Object.freeze(['git', 'memory', 'office']);

export function setBuiltinInstalledInConfig(configLike, id, installed = true) {
  const next = { ...(configLike || {}) };
  next.builtins = { ...(next.builtins || {}) };
  if (installed === true) {
    next.builtins[id] = { ...(next.builtins[id] || {}), installed: true };
  } else {
    const entry = { ...(next.builtins[id] || {}) };
    delete entry.installed;
    next.builtins[id] = entry;
  }
  return next;
}

/** Stamp or grandfather the `builtins` section on config adoption. Returns the
 *  same object when the section already exists, so callers can use identity to
 *  decide whether a persist is needed. */
export function withGrandfatheredBuiltins(configLike) {
  const config = configLike && typeof configLike === 'object' ? configLike : {};
  if (config.builtins && typeof config.builtins === 'object') return config;
  let next = { ...config, builtins: {} };
  // User-mark keys only: a default in-memory config may carry harmless
  // structural keys before onboarding ever writes, and must stay "fresh".
  const existingProfile = ['presets', 'providers', 'modules', 'default', 'memoryTools', 'recap'].some(
    (key) => config[key] !== undefined
  );
  if (existingProfile) {
    for (const id of GRANDFATHERED_BUILTIN_IDS) {
      next = setBuiltinInstalledInConfig(next, id, true);
    }
  }
  return next;
}
