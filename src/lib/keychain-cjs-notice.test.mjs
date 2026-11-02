// A keychain read that fails (here: a Windows DPAPI ciphertext file left empty,
// which fails before any PowerShell runs) is told to the desktop once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerDesktopNoticeSink } from '../runtime/shared/desktop-notice-host.mjs';

const require = createRequire(import.meta.url);

test('a failing keychain read raises the secure-storage notice once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-notice-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const dataDir = process.env.MIXDOG_DATA_DIR;
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    if (dataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = dataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.MIXDOG_DATA_DIR = root;
  fs.mkdirSync(path.join(root, 'secrets'));
  for (const account of ['agent.a.apiKey', 'agent.b.apiKey']) {
    fs.writeFileSync(path.join(root, 'secrets', `${account}.dpapi`), '');
  }
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  const { getSecret } = require('./keychain-cjs.cjs');

  assert.throws(() => getSecret('agent.a.apiKey'), /DPAPI ciphertext file is empty/);
  assert.throws(() => getSecret('agent.b.apiKey'), /DPAPI ciphertext file is empty/);
  assert.deepEqual(notices, [{ key: 'secret-storage', code: 'secret-storage-failed', params: {} }]);
});
