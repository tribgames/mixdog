// The phone/web bundle keeps its own copies of the shared files it reaches; until the backend tree that holds
// the originals is removed, each pair must stay byte-identical. The removal deletes this test with the originals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const NAMES = ['clean', 'tool-execution-contract', 'task-notification-envelope', 'bot-hops', 'shell-display', 'object', 'numbers'];

for (const name of NAMES) {
  test(`src/shared/${name}.mjs is byte-identical to src/runtime/shared/${name}.mjs`, () => {
    const copy = readFileSync(here(`../src/shared/${name}.mjs`));
    const original = readFileSync(here(`../../../src/runtime/shared/${name}.mjs`));
    assert.ok(copy.equals(original));
  });
}

for (const name of ['tool-primitives', 'model-display']) {
  test(`src/rows/${name}.mjs is byte-identical to src/runtime/shared/${name}.mjs`, () => {
    const copy = readFileSync(here(`../src/rows/${name}.mjs`));
    const original = readFileSync(here(`../../../src/runtime/shared/${name}.mjs`));
    assert.ok(copy.equals(original));
  });
}
