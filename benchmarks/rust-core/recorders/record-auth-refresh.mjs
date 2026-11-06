#!/usr/bin/env node
// What the runtime refreshes after credentials change: session-runtime/provider-auth/refresh.mjs
// `createAuthRefresh` over recording collaborators, with the real admission scheduler behind the
// cooldown release. Rust `mixdog_core_domains::domains::ai_account::auth_refresh::AuthRefreshFlow`
// must make the same collaborator calls, in the same order, for each entry point.
//
//   node benchmarks/rust-core/recorders/record-auth-refresh.mjs [--tree <dir>]
//
// Output: native/core/fixtures/auth-refresh/golden.json.
process.env.TZ = 'UTC';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'auth-refresh');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-auth-refresh.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'auth-refresh-rec-'));
const at = (path) => importFrom(tree, path);
const { createAuthRefresh } = await at('src/session-runtime/provider-auth/refresh.mjs');
const { providerAdmissionKey, providerAdmissionScheduler } = await at('src/runtime/agent/orchestrator/providers/admission-scheduler.mjs');

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const KEY = providerAdmissionKey('anthropic-oauth', { name: 'anthropic-oauth', credentials: { accountId: 'refresh-rec' } });

// refresh: how refreshProviderCatalogs behaves; null leaves it out of the dependencies.
const REFRESHES = ['resolves', 'rejects', 'throws', 'absent'];
const ENTRIES = ['afterCredentialChange', 'adoptCredentials', 'afterUsageAuthChange', 'releaseAdmissionCooldowns'];
const scenarios = [];
for (const entry of ENTRIES) {
  for (const refresh of REFRESHES) {
    // The lane holds a rate-limit cooldown from the old credentials.
    providerAdmissionScheduler.resetCooldowns(null);
    providerAdmissionScheduler.recordRateLimit(KEY, Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 60_000 }));
    const blockedBefore = providerAdmissionScheduler.immediateBlock(KEY);
    const calls = [];
    const deps = {
      applyConfigChange: () => calls.push('applyConfigChange'),
      invalidateProviderCaches: () => calls.push('invalidateProviderCaches'),
      warmProviderModelCache: () => calls.push('warmProviderModelCache'),
    };
    if (refresh !== 'absent') {
      deps.refreshProviderCatalogs = (options) => {
        calls.push(`refreshProviderCatalogs:${JSON.stringify(options)}`);
        if (refresh === 'throws') throw new Error('sync failure');
        return refresh === 'rejects' ? Promise.reject(new Error('refresh failed')) : Promise.resolve();
      };
    }
    const api = createAuthRefresh(deps);
    api[entry]();
    const syncCalls = [...calls];
    await flush();
    scenarios.push({ entry, refresh, blockedBefore, syncCalls, calls, blockedAfter: providerAdmissionScheduler.immediateBlock(KEY) });
  }
}
writeJson(join(stage, 'golden.json'), { scenarios });
writeSetManifest(stage, { set: 'auth-refresh', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
