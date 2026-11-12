#!/usr/bin/env node
// The first-response budget each provider states (`firstResponseBudget`, b6f10295a): Vertex AI (a Flex route only,
// vertex-ai.mjs:227), the OpenAI-compatible family (openai-compat.mjs:111: Mimo's own window, the rest on the shared one),
// Mimo (mimo-oauth.mjs:158) and Antigravity (antigravity-oauth.mjs:110, per model family), and the table of every provider the registry builds on
// every route (`table`). Each case is one environment, and records the settings Node resolved from it (`settings`) and the Antigravity budgets
// after the environment is changed once the modules have loaded (`afterEnvironmentChange`: the same, Node reads the variables as its modules load):
// Node reads STALL_TIMEOUT_S, MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS, MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS and
// MIXDOG_ANTIGRAVITY_{RETRY_MAX_ATTEMPTS,RETRY_BACKOFF_MS,FIRST_BYTE_RETRIES,FIRST_BYTE_TIMEOUT_MS} once, as its modules load
// (stall-policy.mjs:24,69, gemini-stream.mjs:25, antigravity-retry-policy.mjs:74-96), so each case runs the probe
// (lib/first-response-budgets-probe.mjs) in a process of its own with exactly those variables, on an empty data dir (no
// cached Antigravity catalog: the curated model rows).
//   node benchmarks/rust-core/recorders/record-first-response-budgets.mjs --tree <export of b6f10295a with node_modules>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecorderError } from './lib/recorder-error.mjs';
import { openSet } from './lib/case-set.mjs';

const PROBE = 'benchmarks/rust-core/recorders/lib/first-response-budgets-probe.mjs';
const set = openSet('first-response-budgets', import.meta.url, { clock: false });
const dataDir = mkdtempSync(join(tmpdir(), 'bench-budgets-'));

// Every variable Node reads for these budgets, so the probe sees only what a case sets.
const VARIABLES = ['STALL_TIMEOUT_S', 'MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS', 'MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS', 'MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS', 'MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS', 'MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES', 'MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS'];
const ENVIRONMENTS = [
  ['no variable is set', {}],
  ['the shared and Gemini windows are set', { MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS: '45000', MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS: '90000' }],
  ['the Gemini window follows the shared one when it is not set', { MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS: '100000' }],
  ['a lower stall threshold lowers every ceiling', { STALL_TIMEOUT_S: '200', MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS: '500000' }],
  ['a stall threshold below the warn floor leaves a one-second ceiling', { STALL_TIMEOUT_S: '20' }],
  ['a stall threshold above the warn cap keeps the default ceiling', { STALL_TIMEOUT_S: '900', MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS: '280000' }],
  ['the Antigravity ladder and window are set', { MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '6', MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '500,1500,3000', MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: '3', MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS: '120000' }],
  ['values outside their bounds are clamped, unreadable ones ignored', { MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: 'abc', MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '1,x', MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: '9', MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS: '10', MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS: '-5' }],
  ['one attempt, one backoff step and no first-byte retry', { MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '0', MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '2000', MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: '0' }],
  ['blank and fractional values fall back; a backoff list with zero steps is read', { MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '2.5', MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: ' ', MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '0, 0 ,7000' }],
  ['more first-byte retries than the ladder has attempts', { MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '2', MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: '5' }],
];

// One table per variable: unset, below its lower bound, above its upper bound, unparsable and a valid value, each in an environment of its own.
// (The bounds: the stall threshold is a positive integer of seconds; the windows are clamped to [30 s, the provider ceiling]; the attempts to 1-6 and
// the first-byte retries to 0-5, integers; a backoff list is whole non-negative steps.)
const PER_VARIABLE = {
  STALL_TIMEOUT_S: ['0', '1000000', 'abc', '200'],
  MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS: ['1000', '99999999', 'abc', '45000'],
  MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS: ['1000', '99999999', 'abc', '90000'],
  MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: ['0', '9', 'abc', '3'],
  MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: ['-1', '99999999999', '1,x', '500,1500'],
  MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: ['-3', '9', 'abc', '2'],
  MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS: ['1000', '99999999', 'abc', '120000'],
};
for (const [variable, [below, above, unparsable, valid]] of Object.entries(PER_VARIABLE)) {
  for (const [kind, value] of [['unset', undefined], ['below its lower bound', below], ['above its upper bound', above], ['unparsable', unparsable], ['a valid value', valid]]) {
    ENVIRONMENTS.push([`${variable}: ${kind}`, value === undefined ? {} : { [variable]: value }]);
  }
}

try {
  for (const [name, env] of ENVIRONMENTS) {
    await set.run(name, () => {
      const childEnv = { ...process.env, MIXDOG_DATA_DIR: dataDir, ...env };
      for (const variable of VARIABLES) if (!(variable in env)) delete childEnv[variable];
      const ran = spawnSync(process.execPath, [fileURLToPath(new URL(`../../../${PROBE}`, import.meta.url)), set.tree], { env: childEnv, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 1 << 20 });
      if (ran.status !== 0) throw new RecorderError(`the probe failed for "${name}": ${ran.stderr}`);
      return { env, budgets: JSON.parse(ran.stdout) };
    });
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

await set.finish({
  entry: { runs: 'VertexAIProvider.firstResponseBudget (vertex-ai.mjs:227), OpenAICompatProvider.firstResponseBudget (openai-compat.mjs:111), MimoOAuthProvider.firstResponseBudget (mimo-oauth.mjs:158), AntigravityOAuthProvider.firstResponseBudget (antigravity-oauth.mjs:110) for every curated Antigravity model, the default and an unlisted id; one process per environment' },
  dataFiles: [PROBE],
  replay: {
    entry: 'mixdog-ai providers::first_byte::FirstByteSettings::from_env over the recorded env of each case, then the real adapters\' first_response_budget: GoogleAdapter (Vertex AI with modelParameters {serviceTier}, Antigravity per model, policy::antigravity_with for the ladder) and CompatAdapter (mimo-oauth and the profiles without a window of their own); compare every budget whole',
    inputs: { environment: 'each case lists the variables it sets (cases[].observed.env); no other variable is set. The replay hands them to FirstByteSettings::from_env as a lookup, not through the process environment', models: 'the curated Antigravity rows (no cached catalog): gemini-3.8-flash is gemini-flash, gemini-3.1-pro and gemini-4-argon are gemini-pro, Claude and gpt-oss have no family' },
  },
});
process.exit(0);
