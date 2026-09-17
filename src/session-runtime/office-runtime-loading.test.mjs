import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('ordinary session startup does not require PDF engines; explicit Office calls still work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-office-loading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let officeEnabled = false;
    const engineRequests = [];
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'pdf-lib' || specifier === '@pdf-lib/fontkit') {
          engineRequests.push(specifier);
          if (!officeEnabled) throw new Error('PDF engine unavailable before Office use');
        }
        return nextResolve(specifier, context);
      },
    });
    const runtime = await import(${JSON.stringify(new URL('../mixdog-session-runtime.mjs', import.meta.url).href)});
    assert.equal(typeof runtime.createMixdogSessionRuntime, 'function');
    const bootstrap = await import(${JSON.stringify(new URL('./runtime-bootstrap.mjs', import.meta.url).href)});
    bootstrap.prepareStandaloneEnvironment();
    await bootstrap.loadRuntimeModules();
    const { createInternalToolExecutor } = await import(${JSON.stringify(new URL('./internal-tool-executor.mjs', import.meta.url).href)});
    const execute = createInternalToolExecutor({
      rt: { currentCwd: process.env.MIXDOG_HOME, config: {}, session: {} },
      officeToolsEnabled: () => officeEnabled,
    });
    await assert.rejects(
      execute('office', { action: 'transactions' }, { invocationSource: 'model-tool' }),
      /office is disabled in settings/,
    );
    assert.deepEqual(engineRequests, []);
    officeEnabled = true;
    const result = await execute('office', { action: 'transactions' }, { invocationSource: 'model-tool' });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, transactions: [] });
    assert.ok(engineRequests.includes('pdf-lib'));
    hooks.deregister();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MIXDOG_HOME: root,
      MIXDOG_DATA_DIR: join(root, 'data'),
      MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});
