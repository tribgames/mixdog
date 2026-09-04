import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import {
  NOTO_FONT_DEFINITIONS,
  getUserFontDirectory,
  isFontInstalled,
  prepareOfficeFonts,
} from './font-provisioner.mjs';

test('Noto font catalog is well-formed and unique', () => {
  const ids = new Set();
  const files = new Set();
  for (const def of NOTO_FONT_DEFINITIONS) {
    assert.match(def.id, /^noto-sans-[a-z]+$/);
    assert.match(def.family, /^Noto Sans/);
    assert.match(def.fileName, /^NotoSans[A-Za-z]*-Variable\.ttf$/);
    assert.match(def.url, /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/main\/ofl\//);
    assert.ok(Number.isInteger(def.bytes) && def.bytes > 0);
    assert.ok(!ids.has(def.id) && !files.has(def.fileName));
    ids.add(def.id);
    files.add(def.fileName);
  }
  assert.ok(ids.has('noto-sans-latin') && ids.has('noto-sans-kr'));
});

test('user font directory is absolute and unknown fonts report their install target', () => {
  const dir = getUserFontDirectory();
  assert.ok(isAbsolute(dir));
  const status = isFontInstalled({ fileName: 'Mixdog-NotInstalled-Probe.ttf' });
  assert.equal(status.installed, false);
  assert.ok(status.path.startsWith(dir));
});

test('prepareOfficeFonts absorbs download failures per font instead of throwing', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const targets = [
    { id: 'probe-a', family: 'Probe A', fileName: 'Mixdog-Probe-A.ttf', registryName: 'Probe A', url: 'https://example.invalid/a.ttf', bytes: 1 },
    { id: 'probe-b', family: 'Probe B', fileName: 'Mixdog-Probe-B.ttf', registryName: 'Probe B', url: 'https://example.invalid/b.ttf', bytes: 1 },
  ];
  const results = await prepareOfficeFonts({ targets });
  assert.deepEqual(Object.keys(results).sort(), ['probe-a', 'probe-b']);
  for (const entry of Object.values(results)) {
    assert.equal(entry.installed, false);
    assert.match(entry.error, /offline/);
  }
});
