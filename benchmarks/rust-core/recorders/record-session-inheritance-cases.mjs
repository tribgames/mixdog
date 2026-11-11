#!/usr/bin/env node
// Recording of apps/desktop/src/renderer/session-inheritance.test.mjs (b6f10295a): a session inheriting another's conversation.
// The real lifecycle API (src/session-runtime/lifecycle-api.mjs createLifecycleApi().inheritFrom) over scripted source and target
// sessions (the session lookup and save are the host's: a recorded function), and the transcript restore (tui/session/session-api-ext.mjs
// restoreTranscriptItems) of the inherited messages, live and as persisted. Recorded: the target messages, the persisted copy, the
// restored items and the rejection of a too-large inheritance (with nothing saved).
//
//   node benchmarks/rust-core/recorders/record-session-inheritance-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-inheritance-cases', import.meta.url);
const { createLifecycleApi } = await set.load('src/session-runtime/lifecycle-api.mjs');
const { restoreTranscriptItems } = await set.load('src/tui/session/session-api-ext.mjs');

await set.run('successful inheritance restores its boundary', async () => {
  const source = {
    id: 'source', provider: 'anthropic-oauth', model: 'claude-fable-5-1',
    messages: [{ role: 'user', content: 'Continue my work.' }, { role: 'assistant', content: 'Previous answer.', meta: { transcript: { provider: 'anthropic-oauth', modelId: 'claude-fable-5-1' } } }],
  };
  const original = structuredClone(source);
  const target = { id: 'heir', provider: 'openai-oauth', model: 'gpt-6-astra', contextWindow: 200_000, compactBoundaryTokens: 200_000, compaction: { auto: true }, tools: [], messages: [{ role: 'system', content: 'Target instructions.' }] };
  const targetBefore = structuredClone(target);
  let persisted;
  let saves = 0;
  const api = createLifecycleApi({ getSession: () => target, mgr: { getSession: () => source }, invalidateContextStatusCache() {}, saveSession: (session) => { saves += 1; persisted = structuredClone(session); } });
  const result = await api.inheritFrom(source.id);
  const restored = {};
  for (const [name, messages] of [['live', target.messages], ['persisted', persisted.messages]]) {
    const items = restoreTranscriptItems(messages, { sessionId: target.id });
    restored[name] = { items, inheritedCount: items.filter((i) => i.status === 'inherited').length, lastStatus: items.at(-1).status, assistantModelId: items.find((i) => i.kind === 'assistant').modelId, itemLimit1First: restoreTranscriptItems(messages, { sessionId: target.id, itemLimit: 1 })[0] };
  }
  return { source: original, targetBefore, inheritFromResult: result, sourceAfter: source, saves, targetMessages: target.messages, persisted, restored };
});
await set.run('rejected inheritance does not persist or display a successful boundary', async () => {
  const target = { id: 'heir', provider: 'openai', model: 'small', messages: [], contextWindow: 1_000, compactBoundaryTokens: 1_000, compaction: { auto: true }, tools: [] };
  const sourceSession = { id: 'source', messages: [{ role: 'user', content: 'Too large for this heir. '.repeat(500) }] };
  let saved = false;
  const api = createLifecycleApi({ getSession: () => target, mgr: { getSession: () => sourceSession }, invalidateContextStatusCache() {}, saveSession: () => { saved = true; } });
  let outcome;
  try { await api.inheritFrom('source'); outcome = { resolved: true }; } catch (e) { outcome = { rejected: e }; }
  return { target: { ...target }, sourceMessageChars: sourceSession.messages[0].content.length, outcome, saved, targetMessagesAfter: target.messages, restoredAfter: restoreTranscriptItems(target.messages) };
});

await set.finish({
  entry: { runs: 'createLifecycleApi().inheritFrom (session-runtime/lifecycle-api.mjs) with scripted getSession / mgr.getSession / saveSession / invalidateContextStatusCache, and restoreTranscriptItems (tui/session/session-api-ext.mjs)', notRun: 'no session store or runtime: the host\'s save function is a recorded stub' },
  replay: { entry: 'mixdog-core-session lifecycle (inheritFrom) and the transcript restore: replay the two scenarios from the recorded source/target and compare the target messages, the persisted copy, the restored items and the rejection text', normalised: {} },
});
process.exit(0);
