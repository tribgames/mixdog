// Environment-variable coercion shared across the runtime.
//
// envFlag: unset/empty keeps `fallback`; only the documented on/off spellings
// flip it, and an unrecognised value (a typo) also keeps the default instead
// of silently enabling or disabling a feature.

import { positiveInt } from './numbers.mjs';

const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

export function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!value) return fallback;
  if (ON_VALUES.has(value)) return true;
  if (OFF_VALUES.has(value)) return false;
  return fallback;
}

export function envPositiveInt(name, fallback = null) {
  return positiveInt(process.env[name], fallback);
}

export function envNonNegativeInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function envPresent(name) {
  return process.env[name] !== undefined && process.env[name] !== '';
}

export function envDelayMs(name, fallback, { min = 0, max = 60_000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
