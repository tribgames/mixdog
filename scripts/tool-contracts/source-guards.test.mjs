// Source-text guards over runtime modules. These are deliberate exceptions to
// behavior-first testing: each one pins an invariant that is cheap to break
// silently in a refactor and expensive to detect live (steering regressions,
// unsaved bench rounds, prompt-cache rewrites). Keep this file small; prefer a
// behavior test whenever the invariant is observable.
import './_env.mjs';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root } from './_env.mjs';
import { assert } from './_helpers.mjs';

test('tool loop sources carry no behavior-steering injected instructions', () => {
  const steeringSources = [
    'src/runtime/agent/orchestrator/session/agent-loop.mjs',
    'src/runtime/agent/orchestrator/session/tool-batch.mjs',
    'src/runtime/agent/orchestrator/session/eager-dispatch.mjs',
    'src/runtime/agent/orchestrator/session/loop/stored-tool-args.mjs',
    'src/runtime/agent/orchestrator/tools/patch/orchestrator.mjs',
  ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
  for (const banned of [
    're-read those files and write a fresh patch',
    'Re-run the fixed action (or a verifying tool)',
    'Fix the failed edit before verification',
    'Correct the argument types/required fields or use a different tool',
    'continue with tool calls',
  ]) {
    assert(!steeringSources.includes(banned), `conflicting injected instruction remains: ${banned}`);
  }
});

test('bench runners refuse to save incomplete rounds', () => {
  const benchRunSrc = readFileSync(resolve(root, 'scripts/bench-run.mjs'), 'utf8');
  if (!/task_complete:\s*results\.length > 0 && completed === results\.length/.test(benchRunSrc)) {
    throw new Error('bench-run must require every task to complete before saving a round');
  }
  if (!/score_complete:\s*results\.length > 0 && taskErrors\.length === 0 && scoreErrors\.length === 0 && \(score\?\.cards\?\.length \|\| 0\) === results\.length/.test(benchRunSrc)) {
    throw new Error('bench-run must require a scorecard for every task before saving a round');
  }
  if (!/not saving incomplete round/.test(benchRunSrc) || !/process\.exit\(1\)/.test(benchRunSrc)) {
    throw new Error('bench-run must not save incomplete rounds and must exit non-zero');
  }
  const taskBenchSrc = readFileSync(resolve(root, 'scripts/task-bench.mjs'), 'utf8');
  if (!/const allowPartial = hasFlag\('--allow-partial'\)/.test(taskBenchSrc) || !/skipped\.length && !allowPartial/.test(taskBenchSrc) || !/process\.exit\(1\)/.test(taskBenchSrc)) {
    throw new Error('task-bench must fail partial scoring unless --allow-partial is explicit');
  }
});

test('setRoute stays next-session-only and refreshes cache fields on live-apply', () => {
  // setRoute must default to "next session only": a bare
  // runtime.setRoute({model}) call (no options) must NOT rewrite a live
  // session's provider/model in place, or a mid-conversation model/provider
  // switch silently forces a full prompt-cache rewrite (seen as a
  // promptΔ spike + cache_ratio=0% turn in session-bench).
  // God-file splits move implementation into module dirs; scan facade + all
  // split modules so these source-text guards survive refactors.
  const readMjsSources = (rel) => {
    const abs = resolve(root, rel);
    if (rel.endsWith('.mjs')) return readFileSync(abs, 'utf8');
    return readdirSync(abs, { recursive: true })
      .filter((f) => String(f).endsWith('.mjs'))
      .map((f) => readFileSync(resolve(abs, String(f)), 'utf8'))
      .join('\n');
  };
  const runtimeSrc = [readMjsSources('src/mixdog-session-runtime.mjs'), readMjsSources('src/session-runtime')].join('\n');
  const setRouteBlock = runtimeSrc.match(/async setRoute\(next, options = \{\}\) \{[\s\S]*?\n    \},\n/)?.[0] || '';
  if (!/applyToCurrentSession = options\?\.applyToCurrentSession === true/.test(setRouteBlock)) {
    throw new Error('setRoute must default applyToCurrentSession to false (model changes apply to the next session only)');
  }
  if (!/const applyLive = applyToCurrentSession \|\| currentSessionEmpty/.test(setRouteBlock)
    || !/if \(!applyLive\)/.test(setRouteBlock)
    || !/return getRoute\(\);/.test(setRouteBlock)) {
    throw new Error('setRoute must early-return before touching a non-empty live session when applyToCurrentSession is false');
  }
  // Empty current session must apply live so /model before the first chat
  // updates route + statusline at once, but compact summary anchors are route
  // history and must keep a compacted session next-session-only. Seeded system
  // or synthetic assistant/tool rows alone must NOT make the session non-empty.
  if (!/!hasRouteHistoryMessage\(session\.messages\)/.test(setRouteBlock)
    || !/!hasRouteHistoryMessage\(session\.liveTurnMessages\)/.test(setRouteBlock)
    || !/SUMMARY_PREFIX/.test(runtimeSrc)
    || !/hasUserConversationMessage\(list\) \|\| list\.some\(isSummaryAnchorMessage\)/.test(runtimeSrc)
    || !/function hasRouteHistoryMessage/.test(runtimeSrc)) {
    throw new Error('setRoute must apply live only to route-empty sessions and must treat compact summary anchors as non-empty route history');
  }
  if (!/createCurrentSession\('model-switch-empty'\)/.test(setRouteBlock)
    || !/createCurrentSession\('model-switch-empty-drain'\)/.test(setRouteBlock)
    || !/const emptySession = getSession\(\)/.test(setRouteBlock)
    || !/cli-model-switch-empty/.test(setRouteBlock)
    || !/invalidatePreSessionToolSurface\?\.\(\)/.test(setRouteBlock)) {
    throw new Error('setRoute must drain in-flight create then recreate empty live sessions so the provider-specific tool surface is rebuilt for /model before first chat');
  }
  const sessionLifecycleSrc = readMjsSources('src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
  const updateSessionRouteBlock = sessionLifecycleSrc.match(/export function updateSessionRoute\(id, route = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '';
  if (!/session\.promptCacheKey = providerCacheKey\(session\.provider\)/.test(updateSessionRouteBlock)
    || !/session\.providerCacheOpts = buildSessionProviderCacheOpts\(session\.provider, session\.id, session\.agent\) \|\| null/.test(updateSessionRouteBlock)) {
    throw new Error('updateSessionRoute must refresh provider-scoped prompt cache fields when an empty live session changes provider/model');
  }
  const sessionSrc = [
    readMjsSources('src/tui/session.mjs'),
    readMjsSources('src/tui/session-local.mjs'),
    readMjsSources('src/tui/session'),
  ].join('\n');
  if (/setRoute\(\{ model: m \}, \{ applyToCurrentSession: true \}\)/.test(sessionSrc)) {
    throw new Error('TUI setModel must not force applyToCurrentSession:true (model changes must apply to the next session only)');
  }
  if (!/routeOpts\.applyToCurrentSession === true/.test(sessionSrc)) {
    throw new Error('TUI setRoute wrapper must default applyToCurrentSession to false');
  }
});
