// manager/env-utils.mjs
// Shared non-negative integer env parser. Extracted verbatim from manager.mjs
// so ask-session (terminal save timeout) and idle-cleanup (interval constants)
// read the identical contract without importing manager.mjs back.
export function nonNegativeIntEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
