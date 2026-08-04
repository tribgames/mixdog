// Env-var / token parsing helpers extracted from loop.mjs.

export function positiveTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
export function envFlag(name, fallback = false) {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
}
export function envTokenInt(name) {
    return positiveTokenInt(process.env[name]);
}
