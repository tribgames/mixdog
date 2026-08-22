// Shared env-boolean parser: unset/empty keeps `fallback`, and only the
// documented off-values flip a default-on flag. Single implementation behind
// the historical `_envFlag` name used by the OpenAI/xAI transport gates.
export function envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

export function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
