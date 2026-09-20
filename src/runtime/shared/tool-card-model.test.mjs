import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveToolCardModel } from './tool-card-model.mjs';
import { GOLDEN_CASES, GIT_GOLDEN_CASES } from './tool-card-model.golden-cases.mjs';

// Golden models were captured from deriveToolCardModel itself; regenerate the
// JSON only when a case or an intended rendering change lands.
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./tool-card-model.golden.json', import.meta.url)), 'utf8')
);

for (const { result, summary, status } of GIT_GOLDEN_CASES) {
  test(`git card text golden: ${summary} (${status})`, () => {
    const model = deriveToolCardModel({ name: 'git', args: { command: 'git status' }, result, nowMs: 20000 });
    assert.equal(model.resultSummary, summary);
    assert.equal(model.terminalStatus, status);
    assert.equal(model.displayedResultBodyText, result.trimEnd());
    assert.match(model.detailLine, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

for (const { id, input, options } of GOLDEN_CASES) {
  test(`deriveToolCardModel golden: ${id}`, () => {
    assert.ok(golden[id], `missing golden entry for ${id}`);
    assert.deepEqual(JSON.parse(JSON.stringify(deriveToolCardModel(input, options))), golden[id]);
  });
}

test('golden file covers exactly the case list', () => {
  assert.deepEqual(Object.keys(golden).sort(), GOLDEN_CASES.map((c) => c.id).sort());
});
