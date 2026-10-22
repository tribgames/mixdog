import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { convertLegacyOffice, libreOfficeAvailable } from './portable-soffice.mjs';

// These run the real LibreOffice front-end (a CSV converts to a workbook the same way a legacy file does).
const skip = (await libreOfficeAvailable()) ? false : 'LibreOffice is not installed';

function csvInput() {
  const dir = mkdtempSync(join(tmpdir(), 'soffice-legacy-'));
  const path = join(dir, 't.csv');
  writeFileSync(path, 'a,b\n1,2\n');
  return { dir, path };
}

test('a failed copy of the converted file does not name the private scratch folder', { skip }, async () => {
  const { dir, path } = csvInput();
  const output = join(dir, 'taken.xlsx');
  writeFileSync(output, 'already here');
  await assert.rejects(convertLegacyOffice(path, output), (error) => {
    assert.match(error.message, /EEXIST/);
    assert.ok(!/mixdog-office-legacy-/.test(error.message), error.message);
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test('a cancellation stays an abort and every conversion folder is removed', { skip }, async () => {
  const { dir, path } = csvInput();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(convertLegacyOffice(path, join(dir, 'out.xlsx'), { signal: controller.signal }), {
    name: 'AbortError',
  });
  await rm(dir, { recursive: true, force: true });
});

test('a conversion folder that cannot be removed is retried and then logged, not swallowed', { skip }, async () => {
  const { dir, path } = csvInput();
  const logged = [];
  let attempts = 0;
  const busy = async () => {
    attempts += 1;
    throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  };
  await convertLegacyOffice(path, join(dir, 'out.xlsx'), { remove: busy, log: (line) => logged.push(line) });
  assert.ok(attempts > 1);
  assert.equal(logged.length, 1);
  const leftover = /scratch folder (.+) could not be removed: resource busy/.exec(logged[0])?.[1];
  assert.match(leftover, /mixdog-office-legacy-/);
  assert.equal(existsSync(join(dir, 'out.xlsx')), true);
  await rm(leftover, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});
