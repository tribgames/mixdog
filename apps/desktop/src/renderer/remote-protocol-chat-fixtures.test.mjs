// The chat fixtures' manifests (remote-protocol-chat-fixtures.mjs): each fixture loads verified, and a copy of it with a file extra,
// missing or changed, or recorded by a recorder that has changed since, is refused.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { FIXTURES, verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

for (const name of Object.keys(FIXTURES)) {
  test(`${name}: the fixture loads verified against its manifest`, () => {
    const { manifest, recordings } = verifiedFixture(name);
    assert.equal(recordings.length, manifest.count);
    assert.ok(manifest.count >= 1);
    if (FIXTURES[name].node) assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  });
}

test('a fixture copy with an extra, a missing or a changed file, or of a changed recorder, is refused', () => {
  const cases = {
    extra: (dir) => writeFileSync(join(dir, '99.json'), '{}'),
    missing: (dir) => rmSync(join(dir, '01.json')),
    changed: (dir) => writeFileSync(join(dir, '01.json'), `${readFileSync(join(dir, '01.json'), 'utf8')} `),
    recorder: (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
      manifest.recorder[FIXTURES.roster.recorder[0]] = '0'.repeat(64);
      writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest));
    },
  };
  const messages = {
    extra: /holds .*99\.json.*its manifest lists/,
    missing: /holds .*its manifest lists .*01\.json/,
    changed: /01\.json is not the recording the manifest names/,
    recorder: /changed since .* was recorded/,
  };
  for (const [kind, change] of Object.entries(cases)) {
    const dir = mkdtempSync(join(tmpdir(), 'chat-fixture-'));
    try {
      cpSync(new URL(FIXTURES.roster.dir, import.meta.url), dir, { recursive: true });
      change(dir);
      assert.throws(() => verifiedFixture('roster', pathToFileURL(`${dir}/`)), messages[kind], kind);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
