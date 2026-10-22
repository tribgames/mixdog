import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { redactDirectories } from './redact-directories.mjs';

test('every spelling of a private directory is taken out of a message', () => {
  const dir = join(tmpdir(), 'a b', 'mixdog-office-legacy-Xy12');
  const text = [
    `${dir}\\report.xls failed`,
    `${dir.replaceAll('\\', '/')}/report.xls failed`,
    `${pathToFileURL(dir).href}/report.xls failed`,
    `in ${dir} itself`,
  ].join('; ');
  const out = redactDirectories(text, [dir]);
  assert.equal(out, 'report.xls failed; report.xls failed; report.xls failed; in  itself');
  assert.ok(!/mixdog-office-legacy/.test(out));
});

test('an empty directory list or an empty entry changes nothing', () => {
  assert.equal(redactDirectories('kept', ['']), 'kept');
  assert.equal(redactDirectories('kept', []), 'kept');
});
