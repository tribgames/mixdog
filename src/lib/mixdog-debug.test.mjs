import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { appendSessionStartCriticalLog } = require('./mixdog-debug.cjs');

test('critical log trims to well below the cap so appends do not rewrite every time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
  try {
    const file = path.join(dir, 'session-start-critical.log');
    fs.writeFileSync(file, 'x'.repeat(64 * 1024 + 1));
    appendSessionStartCriticalLog(dir, 'tail');
    const size = fs.statSync(file).size;
    assert.ok(size <= 40 * 1024, `expected trimmed size, got ${size}`);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('tail\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
