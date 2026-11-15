// The Linux launch smoke (linux-launch-smoke.mjs) waits for lines the app writes: a rename of one in the main
// process must fail here, not in the release gate where every Linux smoke would time out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const smoke = read('./linux-launch-smoke.mjs');
const main = read('../src/main/index.ts');
const constant = (name) => new RegExp(`const ${name} = '([^']+)';`).exec(smoke)?.[1];

test('the events the launch smoke waits for are written by the main process to the diagnostics log it reads', () => {
  for (const name of ['READY_EVENT', 'FAILED_EVENT']) {
    const event = constant(name);
    assert.ok(event, `${name} is not defined in the smoke`);
    assert.match(main, new RegExp(`diagnostics\\??\\.write\\('${event}'`), `index.ts never writes ${event}`);
  }
  // Where the smoke reads them: <MIXDOG_DESKTOP_USER_DATA>/logs/desktop-diagnostics.jsonl.
  assert.match(smoke, /MIXDOG_DESKTOP_USER_DATA: join\(profile, 'user-data'\)/);
  assert.match(smoke, /join\(profile, 'user-data', 'logs', 'desktop-diagnostics\.jsonl'\)/);
});

test('the launch smoke no longer waits for a line the app does not print', () => {
  assert.doesNotMatch(smoke, /transport-ready/);
});
