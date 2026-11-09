// The byline the shared spinner meta shows for the quiet state the core publishes (`spinner.quiet`), against the
// quiet states and bylines Node (b6f10295a `turnQuietState` / `buildSpinnerMeta`) produced for each liveness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NOW } from './spinner-quiet-golden/cases.mjs';
import { buildSpinnerMeta } from './spinner-meta.mjs';

const golden = JSON.parse(readFileSync(new URL('./spinner-quiet-golden/node-quiet.golden.json', import.meta.url), 'utf8'));

for (const recorded of golden.cases) {
  test(`the quiet byline equals Node's: ${recorded.name}`, () => {
    const meta = buildSpinnerMeta({ quiet: recorded.quiet, now: NOW });
    assert.equal(meta.quietText, recorded.quietText);
    if (recorded.quietParts) assert.deepEqual(meta.quietParts, recorded.quietParts);
  });
}

test('no quiet state shows no byline', () => {
  assert.equal(buildSpinnerMeta({ now: NOW }).quietText, '');
});
