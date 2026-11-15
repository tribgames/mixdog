// Records what the Node deploy tool writes for the renderer registry, for tests/tool_renderer_releases.rs
// (`index_json_is_byte_equal_to_the_one_the_node_tool_writes`).
// Run: node renderer_releases_record.mjs <apps/relay/deploy directory of a Node checkout> <scratch directory> > fixtures/renderer-releases-index.json
// It runs prepareReleases on two fixture histories at fixed instants and prints one JSON object: for each, the result lines and
// the index.json text Node wrote. The Rust test replays the same histories and compares the bytes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [deploy, scratch] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(deploy, 'renderer-releases.mjs')).href);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1);

function staged(dir, label) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><meta name="mixdog-shell-version" content="${label.repeat(64).slice(0, 64)}"><body>${label}</body>`
  );
  writeFileSync(join(dir, 'app.js'), `// ${label}`);
}

rmSync(scratch, { recursive: true, force: true });

// History one: the first deploy adopts the installed renderer and adds the new one beside it; a redeploy and a relay-only deploy.
const one = join(scratch, 'adopt');
staged(join(one, 'installed'), 'a');
staged(join(one, 'next'), 'b');
const releases = join(one, 'renderer-releases');
const adoptResults = [
  mod.prepareReleases({ releasesDir: releases, rendererDir: join(one, 'next'), desktopVersion: '1.5.0', legacyDir: join(one, 'installed'), now: NOW }),
  mod.prepareReleases({ releasesDir: releases, rendererDir: join(one, 'next'), desktopVersion: '1.5.0', now: NOW }),
  mod.prepareReleases({ releasesDir: releases, rendererDir: join(one, 'next'), now: NOW }),
];
const adoptIndex = readFileSync(join(releases, 'index.json'), 'utf8');

// History two: five deploys, then two more into a clone of the registry with recently and long unseen devices.
const two = join(scratch, 'gc');
staged(join(two, 'installed'), 'a');
const gcResults = [];
const registry = join(two, 'renderer-releases');
for (const [step, label] of ['b', 'c', 'd', 'e', 'f'].entries()) {
  staged(join(two, 'stage', label), label);
  gcResults.push(
    mod.prepareReleases({
      releasesDir: registry,
      rendererDir: join(two, 'stage', label),
      desktopVersion: `1.${step}.0`,
      legacyDir: join(two, 'installed'),
      now: NOW + step,
    })
  );
}
staged(join(two, 'stage', '1'), '1');
staged(join(two, 'stage', '2'), '2');
const live = join(two, 'live', 'renderer-releases');
mod.linkTree(registry, live);
const devices = [
  { appVersion: '1.2.0', rendererRelease: '', seenAt: NOW - DAY },
  { appVersion: '1.3.0', rendererRelease: '', seenAt: NOW - 90 * DAY },
];
for (const [label, desktopVersion, offset] of [['1', '1.8.0', 10], ['2', '1.9.0', 11]]) {
  gcResults.push(
    mod.prepareReleases({ releasesDir: live, rendererDir: join(two, 'stage', label), desktopVersion, devices, now: NOW + offset })
  );
}
const gcIndex = readFileSync(join(live, 'index.json'), 'utf8');

process.stdout.write(JSON.stringify({ adopt: { results: adoptResults, index: adoptIndex }, gc: { results: gcResults, index: gcIndex } }, null, 2) + '\n');
rmSync(scratch, { recursive: true, force: true });
