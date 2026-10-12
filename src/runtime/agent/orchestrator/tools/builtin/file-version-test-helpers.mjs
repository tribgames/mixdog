import assert from 'node:assert/strict';

// NTFS identities may exceed Number.MAX_SAFE_INTEGER, where +/- 1 can round
// back to the original number. Perturb identity, not its precision.
export function differentFieldValue(current, field, direction = 1) {
  let value;
  if (field === 'ino' || field === 'dev') value = current === 0 ? 1 : 0;
  else value = current + direction * (field.endsWith('Ms') ? 0.5 : 1);
  assert.notEqual(value, current, `${field} fixture must actually differ`);
  return value;
}
