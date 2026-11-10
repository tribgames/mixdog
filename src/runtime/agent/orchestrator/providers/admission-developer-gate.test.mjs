// A dev-gated provider switched off after lookup, or while its request waited
// for admission, must not reach the transport.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-admission-gate-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dir, 'backups');

const { updateSection } = await import('../../../shared/config.mjs');
const { ProviderAdmissionScheduler, wrapProviderAdmission } = await import('./admission-scheduler.mjs');

const setDeveloper = (developer) => updateSection('agent', (current) => ({ ...current, developer }));

test.after(() => rmSync(dir, { recursive: true, force: true }));
test.afterEach(() => {
  delete process.env.MIXDOG_MODEL_PROXY;
});

// The transport blocks its first call on `gate`, holding the single admission slot.
function gatedProvider(name, scheduler, gate = null) {
  const transport = [];
  const provider = {
    name,
    async send(_messages, _model, _tools, opts) {
      transport.push(opts);
      if (transport.length === 1) await gate?.promise;
      return 'sent';
    },
  };
  wrapProviderAdmission(provider, name, scheduler);
  return { provider, transport };
}

test('a send queued for admission is rejected when its Developer option is switched off before dispatch', async (t) => {
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
  t.after(() => scheduler.shutdown());
  setDeveloper({ devinOAuth: true });
  const gate = Promise.withResolvers();
  const { provider, transport } = gatedProvider('devin-oauth', scheduler, gate);
  const held = provider.send([], 'devin-model', [], {});
  const queued = provider.send([], 'devin-model', [], {});
  queued.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.length, 1);

  setDeveloper({});
  gate.resolve();
  assert.equal(await held, 'sent');

  await assert.rejects(queued, (error) => {
    assert.equal(error.code, 'EPROVIDERUNAVAILABLE');
    assert.match(error.message, /devin-oauth.*disabled/);
    return true;
  });
  assert.equal(transport.length, 1, 'only the request admitted before the switch-off reached the transport');
});

test('a send that was admitted while the option is on still goes out', async (t) => {
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
  t.after(() => scheduler.shutdown());
  setDeveloper({ devinOAuth: true });
  const { provider, transport } = gatedProvider('devin-oauth', scheduler);
  assert.equal(await provider.send([], 'devin-model', [], {}), 'sent');
  assert.equal(transport.length, 1);
});

test('remote proxy mode keeps sending: the PC already decided availability', async (t) => {
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
  t.after(() => scheduler.shutdown());
  setDeveloper({});
  process.env.MIXDOG_MODEL_PROXY = 'client';
  const { provider, transport } = gatedProvider('devin-oauth', scheduler);
  assert.equal(await provider.send([], 'devin-model', [], {}), 'sent');
  assert.equal(transport.length, 1);
});
