import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LANES, commandOf } from './k1-lanes.mjs';

const CRATES = fileURLToPath(new URL('../../native/core/crates/', import.meta.url));

function sourcesOf(pkg) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.rs')) out.push(path);
    }
  };
  walk(join(CRATES, pkg));
  return out;
}

test('every lane filter still names a test in its crate', () => {
  for (const [name, lane] of Object.entries(LANES)) {
    const files = sourcesOf(lane.pkg);
    assert.ok(files.length > 0, `${name}: crate ${lane.pkg} has sources`);
    for (const filter of lane.filters) {
      const leaf = filter.split('::').at(-1);
      const hit = files.some((file) => readFileSync(file, 'utf8').includes(leaf));
      assert.ok(hit, `${name}: no source mentions ${filter}`);
    }
  }
});

test('a lane is one cargo run per filter on its package', () => {
  assert.deepEqual(commandOf('advisory-lock', 'cargo nextest run', 'x'), { program: 'cargo', args: ['nextest', 'run', '-p', 'mixdog-tools', '--locked', 'x'] });
  assert.deepEqual(commandOf('provider-contract').args, ['test', '-p', 'mixdog-ai', '--locked']);
});
