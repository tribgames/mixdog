import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rotateBoundedLog } from './rotate-log.mjs';

test('a log past its cap keeps only its tail and a missing log is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-'));
  try {
    const file = path.join(dir, 'tui.log');
    fs.writeFileSync(file, `${'x'.repeat(100)}tail`);
    rotateBoundedLog(file, 64, 8);
    assert.equal(fs.readFileSync(file, 'utf8'), 'xxxxtail');
    rotateBoundedLog(path.join(dir, 'absent.log'), 64, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
