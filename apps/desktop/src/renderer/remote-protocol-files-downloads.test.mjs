// What the files adapter asks the core for each of the phone's download calls: every call of Node's recording (native/core/fixtures/
// file-downloads, b6f10295a) is fed to the adapter with its recorded arguments, and the requests it makes are those derived from the service
// calls Node's own method table made for that call (the recording's `service`; the rule is benchmarks/rust-core/recorders/lib/
// file-download-requests.mjs). The replay over a real mixdogd (remote-protocol-files-downloads.slow.test.mjs) then proves the replies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coreRequests } from '../../../../benchmarks/rust-core/recorders/lib/file-download-requests.mjs';
import { adapter } from './remote-protocol-files.ts';

const recording = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../native/core/fixtures/file-downloads/file-downloads.json', import.meta.url)), 'utf8'));

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

for (const scenario of recording.scenarios) {
  test(`the core is asked, for each call of "${scenario.name}", what Node's service calls give`, async () => {
    let sent = [];
    const client = { call: async (method, params) => (sent.push({ method, params }), method === 'transfer/endRead' ? { ended: true } : {}) };
    const host = { ctx: {}, client: () => client, declareLane() {} };
    let checked = 0;
    for (const [at, step] of scenario.steps.entries()) {
      const call = step.op === 'send' ? step : step.op === 'call' ? step : null;
      if (!call) continue;
      sent = [];
      // An argument the adapter refuses is answered without a request (and Node's table never reached its service).
      try {
        await adapter.calls[call.method](fill(call.params), host);
      } catch {}
      assert.deepEqual(sent, fill(coreRequests(call.service ?? [])), `${scenario.name} #${at + 1} ${call.method}`);
      checked += 1;
    }
    assert.ok(checked > 0 || scenario.steps.every((step) => step.op !== 'call'));
  });
}
