export function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
