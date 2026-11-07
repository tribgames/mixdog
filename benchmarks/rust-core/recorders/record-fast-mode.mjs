#!/usr/bin/env node
// The Anthropic fast-mode capacity policy (WP-AI-CORE): the REAL Node
// `providers/anthropic-fast-mode.mjs` driven through scripted failures of fast requests with an
// explicit clock. After every step the state is probed at the step's `now`: `fastModeAvailable`,
// `fastModeCooldownRemainingMs`, `fastModeDisabledReason`; a `note` step also records the decision
// `noteFastModeCapacityError` returned. Rust `anthropic::fast_mode::FastMode` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-fast-mode.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/fast-mode/golden.json. No network, no credential. The state is
// module-level, so each scenario imports a fresh module instance (`?scenario=N`). Every user
// directory is a fresh temp one BEFORE any product module loads.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'fast-mode-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'fast-mode');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-fast-mode.mjs';
const MODULE = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/anthropic-fast-mode.mjs')).href;

const OVERAGE = 'anthropic-ratelimit-unified-overage-disabled-reason';
const e = (status, extra = {}) => ({ status, message: '', headers: {}, ...extra });
const note = (now, error, fast = true) => ({ op: 'note', now, fast, error });
// A step is `note` (a failure) or `probe` (just the state) or `clear`; `now` is the clock.
const SCENARIOS = [
  { name: 'fresh', steps: [{ op: 'probe', now: 1000 }] },
  { name: 'not_a_fast_request', steps: [note(1000, e(429, { headers: { 'retry-after': '3600' } }), false)] },
  { name: 'not_a_capacity_status', steps: [note(1000, e(500)), note(1000, e(400, { message: 'bad request' })), note(1000, e(503))] },
  { name: 'short_window_keeps_fast', steps: [note(1000, e(429, { headers: { 'retry-after': '5' } })), note(1000, e(529, { headers: { 'retry-after': '19.999' } })), note(1000, e(429, { headers: { 'retry-after-ms': '1500' } })), note(1000, e(429, { headers: { 'retry-after-ms': '19999.5' } }))] },
  { name: 'window_at_the_threshold_downgrades_to_the_floor', steps: [note(1000, e(429, { headers: { 'retry-after': '20' } })), { op: 'probe', now: 600999 }, { op: 'probe', now: 601000 }] },
  { name: 'no_window_uses_the_default_cooldown', steps: [note(5000, e(429)), { op: 'probe', now: 1804999 }, { op: 'probe', now: 1805000 }] },
  { name: 'long_window_is_taken_whole', steps: [note(0, e(529, { headers: { 'retry-after': '3600' } })), { op: 'probe', now: 3599999 }, { op: 'probe', now: 3600000 }] },
  { name: 'a_shorter_cooldown_never_shortens', steps: [note(0, e(429, { headers: { 'retry-after': '3600' } })), note(10000, e(429)), { op: 'probe', now: 3600000 }] },
  { name: 'a_later_cooldown_extends', steps: [note(0, e(429)), note(1000000, e(429, { headers: { 'retry-after': '3600' } })), { op: 'probe', now: 4599999 }, { op: 'probe', now: 4600000 }] },
  { name: 'a_retry_after_ms_header_wins_over_retry_after', steps: [note(0, e(429, { headers: { 'retry-after-ms': '25000', 'retry-after': '5' } }))] },
  { name: 'a_zero_or_empty_header_falls_through', steps: [note(0, e(429, { headers: { 'retry-after-ms': '0', 'retry-after': '10' } })), note(0, e(429, { headers: { 'retry-after-ms': '', 'retry-after': '10' } })), note(0, e(429, { headers: { 'retry-after': '0' } })), { op: 'probe', now: 1800000 }] },
  { name: 'an_unreadable_header_is_no_window', steps: [note(0, e(429, { headers: { 'retry-after': 'soon' } })), { op: 'probe', now: 1800000 }] },
  { name: 'an_explicit_window_wins_over_the_headers', steps: [note(0, e(429, { retryAfterMs: 0, headers: { 'retry-after': '3600' } })), note(0, e(429, { retryAfterMs: 30000, headers: { 'retry-after': '5' } })), { op: 'probe', now: 600000 }] },
  { name: 'a_negative_explicit_window_is_ignored', steps: [note(0, e(429, { retryAfterMs: -5, headers: { 'retry-after': '5' } }))] },
  { name: 'a_transient_overage_reason_downgrades_without_a_cooldown', steps: [note(0, e(429, { headers: { [OVERAGE]: 'out_of_credits' } })), note(0, e(529, { headers: { [OVERAGE]: 'org_level_disabled_until' } })), { op: 'probe', now: 0 }] },
  { name: 'any_other_overage_reason_disables', steps: [note(0, e(429, { headers: { [OVERAGE]: 'org_level_disabled' } })), { op: 'probe', now: 99999999999 }] },
  { name: 'an_empty_overage_reason_disables', steps: [note(0, e(529, { headers: { [OVERAGE]: '' } }))] },
  { name: 'the_overage_header_beats_the_window', steps: [note(0, e(429, { headers: { [OVERAGE]: 'out_of_credits', 'retry-after': '3600' } })), { op: 'probe', now: 1 }] },
  { name: 'fast_mode_not_enabled_disables', steps: [note(0, e(400, { message: 'Fast mode is not enabled for this account' })), note(0, e(400, { message: 'FAST MODE IS NOT ENABLED' })), { op: 'probe', now: 5 }] },
  { name: 'a_400_with_another_message_is_ignored', steps: [note(0, e(400, { message: 'fast mode is enabled' }))] },
  { name: 'clear_re_enables', steps: [note(0, e(400, { message: 'fast mode is not enabled' })), { op: 'clear', now: 10 }, note(10, e(429)), { op: 'clear', now: 20 }] },
];

const stderrWrite = process.stderr.write;
const recorded = [];
let n = 0;
for (const scenario of SCENARIOS) {
  n += 1;
  const policy = await import(`${MODULE}?scenario=${n}`);
  const steps = [];
  for (const step of scenario.steps) {
    const row = { ...step };
    if (step.op === 'note') {
      const { error } = step;
      const err = { status: error.status, message: error.message, headers: error.headers, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
      row.decision = policy.noteFastModeCapacityError(err, { fast: step.fast, now: step.now });
      row.downgraded = policy.fastModeDowngraded(row.decision);
    } else if (step.op === 'clear') policy.clearFastModeCooldown();
    row.available = policy.fastModeAvailable(step.now);
    const remaining = policy.fastModeCooldownRemainingMs(step.now);
    row.cooldownRemainingMs = Number.isFinite(remaining) ? remaining : 'Infinity';
    row.disabledReason = policy.fastModeDisabledReason();
    steps.push(row);
  }
  recorded.push({ name: scenario.name, steps });
}
process.stderr.write = stderrWrite;
writeJson(join(stage, 'golden.json'), { policy: { shortRetryThresholdMs: 20000, minCooldownMs: 600000, defaultCooldownMs: 1800000 }, scenarios: recorded });
writeSetManifest(stage, { set: 'fast-mode', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
