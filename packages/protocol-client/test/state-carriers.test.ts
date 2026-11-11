// Every field of the Node daemon's session state for a finished turn (the real-turn harness's `edit` scenario, `session.read`, ids and
// times normalized) has a carrier in the fold: the snapshot's state sections, as the core publishes them, reproduce it field for field.
// The section of each field is written here from the core's `ThreadState` (thread.rs), independent of the reducer's tables.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import type { Obj } from '../src/obj.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

const node = JSON.parse(readFileSync(new URL('live-turn-state.node.json', import.meta.url), 'utf8')) as Obj;

const SECTION_FIELDS: Record<string, string[]> = {
  runtime: ['busy', 'commandBusy', 'thinking', 'spinner', 'commandStatus', 'progressHint', 'activeTools', 'clientHostPid', 'toasts', 'activeToolSummary', 'toolMode', 'setupChanged'],
  route: ['sessionProvider', 'sessionModel', 'fast', 'fastCapable', 'autoEffort', 'modelParameters', 'selectedContextWindow', 'effort', 'provider', 'model', 'turnEffort', 'effortOptions', 'cwd', 'sessionForkedFrom', 'systemShell', 'webSearchRoute', 'autoClear'],
  context: ['contextPercent', 'contextTokens', 'contextDefaultPercent', 'contextWindow', 'displayContextWindow', 'autoCompactTokenLimit', 'stats', 'rawContextWindow', 'effectiveContextWindowPercent', 'compactBoundaryTokens'],
  agents: ['agentWorkers', 'agentJobs', 'agentScope'],
  workflow: ['workflow', 'orchestrationMode', 'pendingWorkflowSwitch', 'pendingOrchestrationModeSwitch'],
  approvals: ['toolApprovalResult', 'handoffQuestions'],
};
// The fields the fold computes itself (rows, the streaming line, the paged window and its spill state, which comes with the rows) or
// the product owns outside the thread feed.
const OWN = new Set(['items', 'sessionId', 'streamingTail', 'streamingPartial', 'transcriptSpilled', 'toolApproval', 'toolApprovalsWaiting', 'promptHistoryList', 'queued', 'structureRevision']);

test('every field of the Node daemon state has a carrier in the fold', () => {
  const state: Obj = {};
  const carried = new Set<string>();
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    state[section] = Object.fromEntries(fields.filter((f) => node[f] !== undefined && node[f] !== null).map((f) => [f, node[f]]));
    // A null is the section's own null (`activeToolSummary`, `effort`, ...): carried as such.
    for (const f of fields) if (node[f] === null) (state[section] as Obj)[f] = null;
    fields.forEach((f) => carried.add(f));
  }
  if (node.queued !== undefined) state.queued = node.queued;
  const fold = sessionReducer.initial({ thread: { id: String(node.sessionId) }, items: [], state } as unknown as Json);
  const got = desktopSessionState(fold, []) as Obj;
  const missing = Object.keys(node).filter((k) => !OWN.has(k) && !(k in got));
  assert.deepEqual(missing, [], 'fields the fold does not carry');
  for (const k of Object.keys(node)) {
    if (OWN.has(k)) continue;
    assert.deepEqual(got[k], node[k], k);
  }
});
