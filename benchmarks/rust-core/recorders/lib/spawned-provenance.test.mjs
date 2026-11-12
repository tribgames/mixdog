// provenanceWithSpawned: a change to a script the recorder only spawns (or to what that one loads) changes the provenance, and the
// `--only` guard then refuses.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSameOrigin, provenanceWithSpawned } from './spawned-provenance.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('a change to a spawned script, its import or the preload it names makes the --only guard refuse', () => {
  const dir = mkdtempSync(join(here, 'spawned-test-'));
  try {
    mkdirSync(join(dir, 'world'));
    const write = (name, text) => writeFileSync(join(dir, name), text);
    write('recorder.mjs', "const WORLD = new URL('./world/world.mjs', import.meta.url);\n");
    write('world/world.mjs', "import { x } from './helper.mjs';\nconst preload = join(import.meta.dirname, 'clock.mjs');\n");
    write('world/helper.mjs', 'export const x = 1;\n');
    write('world/clock.mjs', "import './deep.mjs';\n");
    write('world/deep.mjs', 'export {};\n');
    const recorder = pathToFileURL(join(dir, 'recorder.mjs')).href;
    const world = join(dir, 'world', 'world.mjs');
    const identity = { commit: 'c' };
    const recorded = { provenance: provenanceWithSpawned(recorder, [world]), product: identity };
    const paths = recorded.provenance.inputs.map((input) => input.path.split('/').pop());
    assert.deepEqual(paths, ['clock.mjs', 'deep.mjs', 'helper.mjs', 'world.mjs']);
    assertSameOrigin(recorded, provenanceWithSpawned(recorder, [world]), identity);
    for (const name of ['world/world.mjs', 'world/helper.mjs', 'world/clock.mjs', 'world/deep.mjs']) {
      const before = JSON.stringify(recorded.provenance);
      writeFileSync(join(dir, name), `${'// changed\n'}${name === 'world/world.mjs' ? "import './helper.mjs';\nconst p = 'clock.mjs';\n" : ''}`);
      assert.throws(() => assertSameOrigin(recorded, provenanceWithSpawned(recorder, [world]), identity), /--only: the scripts or the tree differ/, name);
      assert.equal(before, JSON.stringify(recorded.provenance));
      // restore for the next one
      write('world/world.mjs', "import { x } from './helper.mjs';\nconst preload = join(import.meta.dirname, 'clock.mjs');\n");
      write('world/helper.mjs', 'export const x = 1;\n');
      write('world/clock.mjs', "import './deep.mjs';\n");
      write('world/deep.mjs', 'export {};\n');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
