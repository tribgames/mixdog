import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideDeployPlan,
  fingerprint,
  rendererInputs,
  rendererManifestForFingerprint,
} from './deploy-plan.mjs';

const renderer = { hash: 'renderer-1' };
const relay = { hash: 'relay-1' };

test('an unchanged live deployment skips build, stage, and upload', () => {
  assert.deepEqual(decideDeployPlan({
    previous: { schemaVersion: 1, rendererHash: renderer.hash, relayHash: relay.hash },
    renderer,
    relay,
    outputFresh: false,
  }), {
    rendererChanged: false,
    relayChanged: false,
    rendererBuild: false,
    stageRenderer: false,
    deploy: false,
  });
});

test('a relay-only change uploads no renderer', () => {
  const plan = decideDeployPlan({
    previous: { schemaVersion: 1, rendererHash: renderer.hash, relayHash: 'relay-old' },
    renderer,
    relay,
    outputFresh: false,
  });
  assert.equal(plan.rendererChanged, false);
  assert.equal(plan.relayChanged, true);
  assert.equal(plan.stageRenderer, false);
  assert.equal(plan.deploy, true);
});

test('a fresh renderer artifact is reused when renderer inputs changed', () => {
  const plan = decideDeployPlan({
    previous: { schemaVersion: 1, rendererHash: 'renderer-old', relayHash: relay.hash },
    renderer,
    relay,
    outputFresh: true,
  });
  assert.equal(plan.rendererChanged, true);
  assert.equal(plan.rendererBuild, false);
  assert.equal(plan.stageRenderer, true);
});

test('desktop command edits do not invalidate the live renderer', () => {
  const first = rendererManifestForFingerprint({
    scripts: { test: 'node --test one.test.mjs' },
    dependencies: { react: '^19.2.0' },
  });
  const second = rendererManifestForFingerprint({
    scripts: { test: 'node --test one.test.mjs two.test.mjs' },
    dependencies: { react: '^19.2.0' },
  });
  assert.deepEqual(first, second);
});

test('the live renderer fingerprint includes the renderer source tree', async () => {
  const result = await fingerprint(rendererInputs);
  assert.ok(result.fileCount > 200, `expected renderer sources, got ${result.fileCount}`);
});
