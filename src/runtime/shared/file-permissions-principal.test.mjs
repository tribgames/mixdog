import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cases = [
  {
    name: 'a SID-shaped user name',
    output: '"DESKTOP\\S-1-5-32-544","S-1-5-21-11-22-33-1001"\r\n',
    sid: 'S-1-5-21-11-22-33-1001',
  },
  {
    name: 'a cloud-account SID',
    output: '"AzureAD\\fixture","S-1-12-1-11-22-33-44"\r\n',
    sid: 'S-1-12-1-11-22-33-44',
  },
  {
    name: 'an unstructured diagnostic containing a SID',
    output: 'lookup failed for S-1-5-21-11-22-33-1001',
    sid: null,
  },
];

for (const [index, fixture] of cases.entries()) {
  test(`Windows ACL principal selection handles ${fixture.name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-acl-principal-'));
    const restores = [];
    t.after(async () => {
      for (const restore of restores.reverse()) restore();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    });
    const path = join(root, 'secret');
    await writeFile(path, 'fixture');
    if (process.platform !== 'win32') {
      // The parser is pure; give it the Windows view it checks (platform and
      // the System32 tools it requires to exist) and mock every command.
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      const { SystemRoot, windir } = process.env;
      // Restoration is registered before the first mutation.
      restores.push(() => {
        Object.defineProperty(process, 'platform', platform);
        for (const [key, value] of Object.entries({ SystemRoot, windir })) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      const system32 = join(root, 'windows', 'System32');
      await mkdir(system32, { recursive: true });
      await Promise.all(['whoami.exe', 'icacls.exe'].map((name) => writeFile(join(system32, name), '')));
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      process.env.SystemRoot = join(root, 'windows');
      delete process.env.windir;
    }
    const grants = [];
    t.mock.method(childProcess, 'execFileSync', (file, args) => {
      if (String(file).endsWith('whoami.exe')) return fixture.output;
      grants.push(args.at(-1));
      return '';
    });
    syncBuiltinESMExports();
    const url = new URL('./file-permissions.mjs', import.meta.url);
    url.searchParams.set('principal-fixture', String(index));
    const { disableOwnerOnlyAclSyncBridgeForTests, enforceOwnerOnlyAclWin32 } = await import(url.href);
    // The principal is parsed by this thread's one-shot path (the sync
    // bridge's worker resolves its own, unmocked).
    disableOwnerOnlyAclSyncBridgeForTests();
    if (fixture.sid) {
      enforceOwnerOnlyAclWin32(path, { fresh: true });
      assert.deepEqual(grants, [`*${fixture.sid}:(F)`]);
    } else {
      assert.throws(() => enforceOwnerOnlyAclWin32(path, { fresh: true }), { code: 'EACLNOUSER' });
      assert.deepEqual(grants, []);
    }
  });
}
