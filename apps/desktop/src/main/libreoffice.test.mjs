// The LibreOffice status keeps a cached answer; a renderer-requested refresh
// re-probes it (so an install done outside Mixdog is seen).
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-libreoffice-'));
// A stand-in soffice: node's --version exits 0 like soffice --version. It is
// the only probe candidate, so a LibreOffice installed on this host is never run.
const fakeSoffice = join(root, 'LibreOffice', 'program', process.platform === 'win32' ? 'soffice.com' : 'soffice');

test.after(() => {
  setLibreOfficeCandidatesForTest();
  rmSync(root, { recursive: true, force: true });
});

const { libreOfficeStatus, setLibreOfficeCandidatesForTest } = await import('./libreoffice.ts');
setLibreOfficeCandidatesForTest([fakeSoffice]);

function installExternally() {
  mkdirSync(join(fakeSoffice, '..'), { recursive: true });
  copyFileSync(process.execPath, fakeSoffice);
}

test('a cached missing engine is only replaced by a refresh read', async () => {
  assert.deepEqual(await libreOfficeStatus(), { installed: false });
  installExternally();
  assert.deepEqual(await libreOfficeStatus(), { installed: false }, 'a plain read keeps using the cache');
  assert.equal((await libreOfficeStatus(true)).installed, true, 'a refresh read re-probes and finds the install');
  assert.equal((await libreOfficeStatus()).installed, true, 'later plain reads see the new result');
});

test('every refresh re-probes at once and concurrent refreshes share one probe', async () => {
  rmSync(fakeSoffice);
  const concurrent = await Promise.all([libreOfficeStatus(true), libreOfficeStatus(true), libreOfficeStatus(true)]);
  assert.deepEqual(
    concurrent.map((status) => status.installed),
    [false, false, false]
  );
  installExternally();
  assert.equal((await libreOfficeStatus(true)).installed, true, 'a refresh right after a probe still sees a new install');
});
