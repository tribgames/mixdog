import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  test(`Windows ACL principal selection handles ${fixture.name}`, {
    skip: process.platform !== 'win32',
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-acl-principal-'));
    const path = join(root, 'secret');
    await writeFile(path, 'fixture');
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    });
    const grants = [];
    t.mock.method(childProcess, 'execFileSync', (file, args) => {
      if (String(file).endsWith('whoami.exe')) return fixture.output;
      grants.push(args.at(-1));
      return '';
    });
    syncBuiltinESMExports();
    const url = new URL('./file-permissions.mjs', import.meta.url);
    url.searchParams.set('principal-fixture', String(index));
    const { enforceOwnerOnlyAclWin32 } = await import(url.href);
    if (fixture.sid) {
      enforceOwnerOnlyAclWin32(path, { fresh: true });
      assert.deepEqual(grants, [`*${fixture.sid}:(F)`]);
    } else {
      assert.throws(() => enforceOwnerOnlyAclWin32(path, { fresh: true }), { code: 'EACLNOUSER' });
      assert.deepEqual(grants, []);
    }
  });
}
