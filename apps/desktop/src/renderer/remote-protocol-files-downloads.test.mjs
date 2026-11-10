// What the files adapter asks the core for each of the phone's five download calls: every call of the "authorize then begin", "range reads"
// and "finish and abort" scenarios of Node's recording (native/core/fixtures/file-downloads, b6f10295a) is fed to the adapter with its recorded
// arguments, and the requests it makes are the ones in native/core/fixtures/file-download-requests/core-requests.json, which the replay over a
// real mixdogd (remote-protocol-files-downloads.slow.test.mjs) proves are what the adapter sends for the whole recording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter } from './remote-protocol-files.ts';

const fixtures = (name, file) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../native/core/fixtures/${name}/${file}`, import.meta.url)), 'utf8'));
const recording = fixtures('file-downloads', 'file-downloads.json');
const requests = fixtures('file-download-requests', 'core-requests.json');

// A recorded id is a token (`<grantId#0>`); the adapter checks the shape of an id and of a version, so each token is a value of that shape.
const ids = new Map();
const fill = (value) => {
  if (typeof value === 'string') {
    if (value === '<dir>' || value.startsWith('<dir>/')) return value.replace('<dir>', 'C:/replay');
    if (/^<version#\d+>$/.test(value)) return 'A'.repeat(43);
    if (/^<\w+#\d+>$/.test(value)) {
      if (!ids.has(value)) ids.set(value, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
      return ids.get(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
  return value;
};

for (const name of ['authorize then begin', 'range reads', 'finish and abort']) {
  test(`the core is asked, for each call of "${name}", what the recording's requests are`, async () => {
    const steps = recording.scenarios.find((scenario) => scenario.name === name).steps;
    const wanted = requests.scenarios.find((scenario) => scenario.name === name).steps;
    let sent = [];
    const client = { call: async (method, params) => (sent.push({ method, params }), method === 'transfer/endRead' ? { ended: true } : {}) };
    const host = { ctx: {}, client: () => client, declareLane() {} };
    let checked = 0;
    for (const [at, step] of steps.entries()) {
      if (step.op !== 'call') continue;
      sent = [];
      // An argument the adapter refuses is answered without a request (the recorded list for that call is empty).
      try {
        await adapter.calls[step.method](fill(step.params), host);
      } catch {}
      assert.deepEqual(sent, fill(wanted[at]), `${name} #${at + 1} ${step.method}`);
      checked += 1;
    }
    assert.ok(checked > 0);
  });
}

