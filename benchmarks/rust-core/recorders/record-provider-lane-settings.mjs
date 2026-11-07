#!/usr/bin/env node
// The settings of the process-wide provider admission lanes (providers/admission-scheduler.mjs):
// which providers' lanes are adaptive (a rate limit opens a cooldown only there) and the queue
// bound the environment sets (MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE), read from the real
// `ProviderAdmissionScheduler`. Rust `mixdog_ai::admission::provider_lane_settings` must give the
// same, so a cache warm opens the lane with the settings ordinary sends use.
//
//   node benchmarks/rust-core/recorders/record-provider-lane-settings.mjs [--tree <dir>]
//
// Output: native/core/fixtures/provider-lane-settings/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-lane-settings');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-provider-lane-settings.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'lane-settings-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'lane-settings-home-'));
const { ProviderAdmissionScheduler } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/admission-scheduler.mjs');

const PROVIDERS = ['anthropic', 'anthropic-oauth', 'Anthropic', 'ANTHROPIC-OAUTH', 'openai', 'openai-oauth', 'anthropic-vertex', 'xai', 'grok-oauth', 'custom-1', 'gemini', ''];
const adaptive = PROVIDERS.map((provider) => {
  const scheduler = new ProviderAdmissionScheduler();
  const recorded = scheduler.recordRateLimit(`${provider}:default`, Object.assign(new Error('429'), { status: 429, retryAfterMs: 1000 }));
  return { provider, adaptive: recorded === true };
});

// The queue bound shows in the refusal of the first request that does not fit.
const ENV = [undefined, '3', '0', '-4', 'abc', '2.9', ' 7 ', '', '1e1', 'Infinity', '5000'];
const queue = [];
for (const value of ENV) {
  if (value === undefined) delete process.env.MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE;
  else process.env.MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE = value;
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
  let refusal = null;
  const hold = () => new Promise(() => {});
  scheduler.run('p:default', hold).catch(() => {});
  for (let i = 0; i < 6000 && refusal === null; i += 1) {
    scheduler.run('p:default', hold).catch((error) => {
      refusal ??= error.message;
    });
    await Promise.resolve();
  }
  queue.push({ env: value ?? null, refusal });
}
delete process.env.MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE;

writeJson(join(stage, 'golden.json'), { adaptive, queue });
writeSetManifest(stage, { set: 'provider-lane-settings', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
