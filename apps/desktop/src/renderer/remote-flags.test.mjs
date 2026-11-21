import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const table = JSON.parse(
  readFileSync(
    new URL('../../../../native/core/crates/mixdog-app-protocol/src/remote_flags.json', import.meta.url),
    'utf8'
  )
);

async function bundledClaims() {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter(
    (name) => /^remote-protocol-[^.]+\.ts$/.test(name) && name !== 'remote-protocol-queue.ts'
  );
  const claims = new Map();
  for (const file of files.sort()) {
    const { adapter } = await import(new URL(file, dir).href);
    if (!adapter) continue;
    for (const call of [...Object.keys(adapter.calls ?? {}), ...Object.keys(adapter.fires ?? {})])
      claims.set(call, adapter.group);
  }
  return claims;
}

test('a flag is on exactly when every call it opens is served for a phone, adapter included', async () => {
  const claims = await bundledClaims();
  const wrong = [];
  for (const [flag, { calls }] of Object.entries(table.flags)) {
    for (const [call, { method, owner }] of Object.entries(calls)) {
      if (method && !claims.has(call))
        wrong.push(`${flag}.${call}: the table serves it by ${method}, but no bundled adapter claims it`);
      if (owner && claims.has(call))
        wrong.push(
          `${flag}.${call}: the '${claims.get(call)}' adapter claims it, but the table still waits on ${owner}`
        );
    }
  }
  assert.deepEqual(wrong, []);
});
