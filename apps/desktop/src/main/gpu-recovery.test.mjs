import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readActiveGpuFallbackMarker, writeGpuFallbackMarker } from './gpu-recovery.ts';

const environment = { platform: 'win32', appVersion: '1.3.1', electronVersion: '40.0.0' };
const MARKER = 'gpu-rendering-fallback.json';

function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-gpu-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a written marker reads back and leaves no temporary file', (t) => {
  const dir = join(profile(t), 'userData');
  writeGpuFallbackMarker(dir, { engagedAt: 5, crashesInWindow: 3 }, environment);
  assert.equal(readActiveGpuFallbackMarker(dir, environment)?.engagedAt, 5);
  assert.deepEqual(readdirSync(dir), [MARKER]);
});

test('a NUL-filled marker is no marker: cleared, and a new one can be written', (t) => {
  const dir = profile(t);
  writeFileSync(join(dir, MARKER), Buffer.alloc(100));
  assert.equal(readActiveGpuFallbackMarker(dir, environment), null);
  assert.equal(existsSync(join(dir, MARKER)), false);
  writeGpuFallbackMarker(dir, { engagedAt: 9, crashesInWindow: 3 }, environment);
  assert.equal(JSON.parse(readFileSync(join(dir, MARKER), 'utf8')).engagedAt, 9);
});
