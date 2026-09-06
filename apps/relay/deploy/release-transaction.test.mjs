import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bash = process.platform === 'win32'
  ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';
const harness = fileURLToPath(new URL('./release-transaction.test.sh', import.meta.url)).replaceAll('\\', '/');

for (const scenario of [
  'success', 'preparation-fails', 'first-move-fails', 'second-move-fails',
  'restart-fails', 'verify-fails', 'interrupted', 'stop-fails', 'rollback-start-fails',
]) {
  test(`release transaction: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-release-transaction-'));
    const install = join(root, 'mixdog-relay');
    const next = join(root, 'mixdog-relay.next-v0.0.1');
    const backup = join(root, 'mixdog-relay.backup-v0.0.1');
    try {
      await mkdir(install);
      await mkdir(next);
      await writeFile(join(install, 'release'), 'old');
      await writeFile(join(next, 'release'), 'new');
      const result = spawnSync(bash, [
        '--noprofile', '--norc', harness, root.replaceAll('\\', '/'), scenario,
      ], { encoding: 'utf8', timeout: 15000 });
      if (result.error) throw result.error;
      const expectedStatus = scenario === 'success' ? 0
        : scenario === 'interrupted' ? 143
          : ['stop-fails', 'rollback-start-fails'].includes(scenario) ? 90 : 1;
      assert.equal(result.status, expectedStatus, result.stderr);
      assert.equal(await readFile(join(install, 'release'), 'utf8'),
        ['success', 'stop-fails'].includes(scenario) ? 'new' : 'old');
      if (['success', 'stop-fails'].includes(scenario)) {
        assert.equal(await readFile(join(backup, 'release'), 'utf8'), 'old');
      }
      if (['preparation-fails', 'first-move-fails'].includes(scenario)) {
        await assert.rejects(readFile(join(root, 'service-operations')), { code: 'ENOENT' });
      }
      if (scenario === 'second-move-fails') {
        assert.equal(await readFile(join(root, 'service-operations'), 'utf8'),
          'stop mixdog-relay\nrestart mixdog-relay\nis-active --quiet mixdog-relay\n');
      }
      if (['stop-fails', 'rollback-start-fails'].includes(scenario)) {
        assert.match(result.stderr, /ROLLBACK FAILED/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
