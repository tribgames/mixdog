import { createHash } from 'node:crypto';

export function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

export function compact(value, maximum = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

export function imageBuffer(image) {
  if (Buffer.isBuffer(image?.data)) return image.data;
  return Buffer.from(String(image?.data || ''), 'base64');
}
