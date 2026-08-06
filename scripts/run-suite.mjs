#!/usr/bin/env node
// Named test suites, so package.json keeps one entry per suite instead of a
// 2KB command line. Files listed here are RUN; anything under scripts/ that is
// not in a suite (or another npm script) is dead weight by definition.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// contract: the cheap, always-true invariants (tool args, session/steering
// persistence, memory rules, routing sanitizers). Live-model, UI-frame and
// bench suites deliberately stay out — they belong to smoke:*/bench:*.
export const SUITES = {
  contract: [
    'abort-queued-drain-kick-test.mjs',
    'agent-dispatch-abort-compose-test.mjs',
    'agent-loop-policy-test.mjs',
    'agent-trace-io-test.mjs',
    'anthropic-admission-retry-integration-test.mjs',
    'anthropic-maxtokens-test.mjs',
    'arg-guard-test.mjs',
    'async-notify-settlement-test.mjs',
    'background-task-meta-smoke.mjs',
    'dead-owner-attach-test.mjs',
    'debounced-skills-async-save-test.mjs',
    'dispatch-persist-recovery-test.mjs',
    'explore-prompt-policy-test.mjs',
    'find-fuzzy-hidden-test.mjs',
    'ingest-pure-conversation-smoke.mjs',
    'internal-tools-normalization-test.mjs',
    'legacy-config-cleanup-test.mjs',
    'lifecycle-api-test.mjs',
    'live-share-test.mjs',
    'max-output-recovery-persist-test.mjs',
    'mcp-client-normalization-test.mjs',
    'mcp-grace-deferred-test.mjs',
    'memory-core-input-test.mjs',
    'memory-meta-concurrency-test.mjs',
    'memory-retention-test.mjs',
    'memory-rule-contract-test.mjs',
    'memory-worker-stability-test.mjs',
    'model-list-sanitize-test.mjs',
    'notify-completion-mirror-test.mjs',
    'openai-oauth-refresh-race-test.mjs',
    'openai-ws-early-settle-test.mjs',
    'parent-abort-link-test.mjs',
    'path-suffix-test.mjs',
    'pending-completion-drop-test.mjs',
    'pending-messages-lock-nonblocking-test.mjs',
    'pretool-ask-runtime-test.mjs',
    'prompt-input-parity-test.mjs',
    'reactive-compact-persist-smoke.mjs',
    'repl-stream-finalize-test.mjs',
    'result-classification-test.mjs',
    'rg-runner-test.mjs',
    'sanitize-tool-pairs-test.mjs',
    'save-worker-delta-test.mjs',
    'session-ingest-smoke.mjs',
    'session-title-controller-test.mjs',
    'set-effort-config-test.mjs',
    'shell-jobs-windows-hide-test.mjs',
    'statusline-agents-test.mjs',
    'statusline-quota-hysteresis-test.mjs',
    'steering-fold-provenance-test.mjs',
    'steering-persist-orphan-prune-test.mjs',
    'stop-hook-informational-exit1-test.mjs',
    'stream-stall-budget-test.mjs',
    'title-completion-test.mjs',
    'tool-output-budget-test.mjs',
    'tool-result-hook-test.mjs',
    'turn-snapshot-test.mjs',
    'usage-metrics-epoch-smoke.mjs',
    'web-fetch-routing-test.mjs',
    'webhook-smoke.mjs',
    'worker-notify-rejection-test.mjs',
    'write-backpressure-test.mjs',
  ],
};

const name = process.argv[2];
const files = SUITES[name];
if (!files) {
  process.stderr.write(`unknown suite: ${name}. known: ${Object.keys(SUITES).join(', ')}
`);
  process.exit(2);
}
// Bounded concurrency: the default (one worker per core) ran ~60 node processes
// at once, which spiked memory and made lock-contending suites (OAuth keychain,
// config RMW) fail from load rather than from a real regression.
const concurrency = Number(process.env.MIXDOG_SUITE_CONCURRENCY) > 0
  ? Math.floor(Number(process.env.MIXDOG_SUITE_CONCURRENCY))
  : 4;
const result = spawnSync(
  process.execPath,
  ['--test', `--test-concurrency=${concurrency}`, ...files.map((f) => join(here, f))],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
