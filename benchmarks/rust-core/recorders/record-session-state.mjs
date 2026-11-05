#!/usr/bin/env node
// Recorded `session-state` streams (P §14.12): a scripted daemon publishes
// DesktopSessionState snapshots covering every field of the contract (see
// apps/desktop/src/shared/contract-session.ts DesktopSessionState) through the
// REAL SessionHost + DesktopService + delta encoder of today's desktop; every
// `session-state` message that crosses the service boundary is stored with
// the folded renderer state (the delta decoder's snapshot after that frame).
// The Rust feed + client-library fold must reproduce `decoded` field for field.
//
//   cd <tree>/apps/desktop   (needs apps/desktop/node_modules)
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs \
//        <repo>/benchmarks/rust-core/recorders/record-session-state.mjs --tree <tree>
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FIXTURES_ROOT, commitStage, stageSet, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const D = (rel) => importFrom(tree, `apps/desktop/src/${rel}`);
const { createDesktopService } = await D('main/desktop-service.ts');
const { createSnapshotDeltaDecoder } = await D('main/state-delta.ts');
const { viewSyncHost } = await D('main/test-support/view-sync-host.mjs');

const { createTurnStream, appendTextDelta, flushStreamBatch } = await importFrom(tree, 'src/tui/session/turn-stream.mjs');
const item = (id, kind, text, extra = {}) => ({ id, kind, text, ...extra });
// The streaming tail/partial pair comes from the product's own turn stream (the tail is the
// completed lines, `from` its length), never hand-written.
const streamed = (fullText) => {
  let state = {};
  const stream = createTurnStream({
    getState: () => state,
    set: (p) => { state = { ...state, ...p }; },
    isCurrentTurn: () => true,
    routeMeta: {},
    nextId: () => 's1',
    transcriptMeta: {},
    updateStreamingTail: (id, patch) => { state = { ...state, streamingTail: { ...(state.streamingTail || {}), ...patch, kind: 'assistant', id, streaming: true } }; },
  });
  appendTextDelta(stream, fullText);
  flushStreamBatch(stream);
  clearTimeout(stream.batchTimer);
  clearTimeout(stream.partialTimer);
  return { streamingTail: item('s1', 'assistant', state.streamingTail.text, { streaming: true }), streamingPartial: state.streamingPartial };
};
const base = { busy: false, queued: [], items: [item('u1', 'user', 'hello'), item('a1', 'assistant', 'hi there')] };

// Each step is one daemon publication. Together they set every contract field.
const steps = [
  ['idle', { ...base }],
  ['turn-start', { ...base, busy: true, thinking: { mode: 'thinking', startedAt: 1000 }, spinner: { label: 'Thinking', since: 1000 }, items: [...base.items, item('u2', 'user', 'write a haiku')] }],
  ['streaming-tail', { ...base, busy: true, items: [...base.items, item('u2', 'user', 'write a haiku')], ...streamed('Autumn moon\nrising slow over') }],
  ['streaming-grow', { ...base, busy: true, items: [...base.items, item('u2', 'user', 'write a haiku')], ...streamed('Autumn moon\nrising slow\nover the hills') }],
  ['tool-approval', { ...base, busy: true, toolApproval: { id: 'ap1', tool: 'shell', target: 'rm -rf build', device: null }, toolApprovalsWaiting: 2, activeTools: { shell: { active: true, count: 1 } }, shellJobs: { running: 1, jobs: [{ id: 'j1', command: 'npm test', state: 'running' }] }, hostShellJobs: { running: 2, jobs: [] } }],
  ['approval-resolved', { ...base, busy: true, toolApprovalResult: { id: 'ap1', approved: true, device: 'desktop-1', at: 2000 }, toolApprovalsWaiting: 0 }],
  ['queued-and-commands', { ...base, busy: false, commandBusy: true, commandStatus: { label: 'Compacting', since: 3000 }, queued: [{ id: 'q1', text: 'next prompt' }], progressHint: { text: 'Compacting context', tone: 'info', percent: 40 } }],
  ['goal-todo-quota', { ...base, goal: { id: 'g1', objective: 'ship it', status: 'active', tasks: [{ id: 't1', text: 'write tests', status: 'pending' }] }, todo: { items: [{ id: 'd1', text: 'step 1', status: 'in_progress' }] }, quotaResume: { resetAt: 9000, provider: 'anthropic', model: 'claude', attempts: 1 } }],
  ['route-and-context', { ...base, sessionProvider: 'anthropic', sessionModel: 'claude-sonnet-4-6', fast: true, fastCapable: true, autoEffort: false, modelParameters: { effort: 'high' }, contextPercent: 37, contextTokens: 200000, contextDefaultPercent: 80, selectedContextWindow: 200000, desktopSessionTitle: 'Fixture session', remoteEnabled: true }],
  ['agents-workflow', { ...base, agentWorkers: [{ id: 'w1', tag: 'worker', state: 'running' }], agentJobs: [{ id: 'job1', state: 'done' }], workflow: { id: 'wf1', name: 'default', step: 2 }, orchestrationMode: 'auto', pendingWorkflowSwitch: true, pendingOrchestrationModeSwitch: false }],
  ['handoff-restore-workspace', { ...base, handoffQuestions: [{ id: 'hq1', sessionId: 'agent-1', question: 'Proceed?' }], promptRestore: { id: 'pr1', ids: ['sub-9'], text: 'cancelled prompt', device: 'phone-1', at: 4000 }, providerAccountChange: { provider: 'openai-oauth', accountId: 'acct-2', at: 4100 }, workspace: { cwd: '<WS>', worktree: null, revision: 3 }, transcriptHasOlder: true }],
  ['row-kinds', { ...base, busy: true, items: [
    ...base.items,
    item('u3', 'user', 'look at this [Image #1]', { messageId: 'm-u3', device: 'desktop-1', images: [{ id: 1, name: 'shot.png', mimeType: 'image/png', bytes: 2048, attachmentRef: 'sha256-aa' }], attachments: [{ id: 'sha256-aa', kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 2048 }, { id: 'sha256-bb', kind: 'file', name: 'notes.txt', mimeType: 'text/plain', size: 90 }] }),
    item('u4', 'user', `fix this [Pasted text #1 +40 lines]\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long paste`).join('\n')}`, { messageId: 'm-u4' }),
    item('t1', 'tool', '', { name: 'read', args: { path: 'src/app.ts' }, result: 'file body', rawResult: 'file body', isError: false, count: 1, completedCount: 1, startedAt: 5000, completedAt: 5040, expanded: false, headerFinalized: true }),
    item('t2', 'tool', '', { name: 'shell', args: { command: 'npm test' }, result: 'exit 1', isError: true, count: 1, completedCount: 1, startedAt: 5100, completedAt: 5900, errorCount: 1, exitErrorCount: 1 }),
    item('t3', 'tool', '', { name: 'grep', args: { pattern: 'TODO' }, result: null, isError: false, count: 1, completedCount: 0, startedAt: 6000 }),
    item('g1', 'tool', '', { name: '__aggregate__', aggregate: true, count: 3, completedCount: 2, categories: { read: 2, search: 1 }, toolMembers: [{ callId: 'c1', name: 'read', args: { path: 'a.ts' }, category: 'read' }, { callId: 'c2', name: 'read', args: { path: 'b.ts' }, category: 'read' }, { callId: 'c3', name: 'grep', args: { pattern: 'x' }, category: 'search' }], startedAt: 6100 }),
    item('u5', 'user', 'also handle the empty case', { messageId: 'm-u5', steered: true }),
    item('u6', 'user', 'queue this', { messageId: 'm-u6', steer: 'pending' }),
    item('r1', 'user', 'team, status?', { room: { id: 'rm1', kind: 'user', to: ['alice', 'bob'], toName: ['Alice', 'Bob'] } }),
    item('r2', 'assistant', 'Done with the parser.', { room: { id: 'rm2', kind: 'speech', speaker: 'alice', name: 'Alice', to: ['bob'], toName: ['Bob'] } }),
    item('r3', 'assistant', '', { room: { id: 'rm3', kind: 'pass', speaker: 'bob', name: 'Bob' } }),
    item('c1', 'statusdone', '', { status: 'compacted', label: 'Conversation compacted', detail: '120k -> 18k tokens', at: 7000 }),
  ] }],
  ['turn-done', { ...base, busy: false, items: [...base.items, item('u2', 'user', 'write a haiku'), item('a2', 'assistant', 'Autumn moon\nrising slow\nover the hills'), item('d1', 'turndone', '', { outcome: 'ok', elapsedMs: 1200 })] }],
  ['cleared-fields', { ...base, items: [item('a2', 'assistant', 'Autumn moon')] }],
];

const f = await viewSyncHost({ runTurns: true });
const frames = [];
const faults = [];
const decoder = createSnapshotDeltaDecoder();
const receive = (message) => {
  try {
    const transferred = JSON.parse(JSON.stringify(message));
    if (transferred.kind !== 'session-state' || transferred.sessionId !== 'lead') return;
    const decoded = decoder.decode(transferred.wire);
    frames.push({ step: current, wire: transferred.wire, ok: decoded.ok === true, decoded: decoded.snapshot ?? null });
  } catch (error) {
    faults.push(String(error?.message ?? error));
  }
};
let current = 'initial';
const service = await createDesktopService({
  options: f.options,
  runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
  emit: receive,
});
try {
  const wsPath = f.directory.replaceAll('\\', '/');
  f.put('lead', 'seed');
  await service.invoke('setVisibleSessions', [['lead']]);
  await delay(100);
  for (const [name, snap] of steps) {
    current = name;
    f.putSnapshot('lead', JSON.parse(JSON.stringify(snap).replaceAll('<WS>', wsPath)));
    await delay(120);
  }
  current = 'resync';
  await service.control({ kind: 'session-state-resync', sessionId: 'lead' });
  await delay(120);
  const scrub = (v) => JSON.parse(JSON.stringify(v).replaceAll(wsPath, '<WS>').replaceAll(f.directory, '<WS>').replaceAll(JSON.stringify(f.directory).slice(1, -1), '<WS>'));
  const finalOut = join(FIXTURES_ROOT, 'session-state');
  const out = stageSet(finalOut);
  writeJson(join(out, 'steps.json'), { note: 'daemon-side snapshots published, in order; <WS> = workspace dir', steps: steps.map(([name, snapshot]) => ({ name, snapshot })) });
  writeJson(join(out, 'stream.json'), { sessionId: 'lead', faults, frames: scrub(frames) });
  const fields = new Set(steps.flatMap(([, s]) => Object.keys(s)));
  writeSetManifest(out, {
    set: 'session-state',
    recorder: 'benchmarks/rust-core/recorders/record-session-state.mjs',
    command: '(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/benchmarks/rust-core/recorders/record-session-state.mjs --tree <tree>',
    extra: { frames: frames.length, fieldsCovered: [...fields].sort() },
  });
  commitStage(out, finalOut);
  console.log(`frames=${frames.length} faults=${faults.length} fields=${fields.size}`);
} finally {
  await service.dispose?.();
  await f.close();
}
