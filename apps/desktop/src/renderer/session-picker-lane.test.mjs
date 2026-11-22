import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Node'],
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.mixdogDesktop = { rendererDiagnostic() {} };

const { createSessionLane } = await import('../shared/core-lanes/session-lane.ts');
const { sessionReducer } = await import('../../../../packages/protocol-client/src/session-state.ts');
const { createSessionLaneStore, useSessionLane } = await import('./session-lane-store.ts');
const { desktopConversationShellSnapshotsEqual, desktopStreamingTailSnapshotsEqual, paneConversationView } =
  await import('./desktop-snapshot-store.ts');
const { useSessionRouteChoices } = await import('./model-controls.tsx');
const { useRouteLabelParts, ComposerRouteLabel } = await import('./composer-route-label.tsx');
const { storeWorkflowOptions } = await import('./workflow-options-cache.ts');

const alpha = { id: 'alpha', name: 'Alpha', description: 'Alpha pack', source: 'built-in', delegatesAgents: true };
const beta = { id: 'beta', name: 'Beta', description: 'Beta pack', source: 'built-in', delegatesAgents: true };

/** The core's ordered stream for one followed thread, folded by the client library and projected by the desktop lane into the
 *  renderer's lane store; the pane reads it as PaneConversation does (the conversation shell's equality) and the dock derives
 *  the picker rows and the route label from that read. */
function rig(id) {
  let fold = sessionReducer.initial({
    thread: { id },
    items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }], meta: {} }],
    hasOlder: false,
    state: {
      runtime: { busy: true },
      route: { provider: 'openai', model: 'gpt-a', effort: 'low', fast: false, autoEffort: false, modelParameters: {} },
      context: { contextPercent: 100 },
      workflow: {
        workflow: alpha,
        orchestrationMode: 'balanced',
        pendingWorkflowSwitch: false,
        pendingOrchestrationModeSwitch: false,
      },
    },
  });
  const listeners = new Set();
  let seq = 1;
  const client = {
    pendingServerRequests: () => [],
    store: { thread: () => ({ feed: { id, epoch: 'e1', seq }, order: 1, state: fold }), section: () => undefined },
  };
  const lane = createSessionLane({
    protocol: {
      client: () => client,
      onStoreChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onEvent: () => () => {},
      onReplaced: () => () => {},
      call: async () => ({ threads: [] }),
    },
  });
  const store = createSessionLaneStore();
  const stop = store.start((listener) => lane.subscribeSessionStates(listener));
  /** The notes, each followed by the core's closing `thread/frame`, as the session actor publishes them. */
  const publish = (...notes) =>
    act(async () => {
      for (const note of [...notes, { method: 'thread/frame', params: { threadId: id, structureChanged: false } }]) {
        seq += 1;
        fold = sessionReducer.apply(fold, { ...note, params: { threadId: id, ...note.params } });
        for (const listener of listeners) listener({ type: 'thread', threadId: id });
      }
      // The lane store notifies a non-urgent change on the next layout frame: this waits for that frame.
      await new Promise((resolve) =>
        (globalThis.requestAnimationFrame ?? window.requestAnimationFrame)(() => setTimeout(resolve, 0))
      );
    });
  const dispose = () => {
    stop();
    lane.dispose();
    store.clear();
  };
  return { store, publish, dispose };
}

function Pane({ id, store }) {
  const snapshot = useSessionLane(id, store, desktopConversationShellSnapshotsEqual);
  // The live reply's text is read as PaneAssistantRow reads it.
  const live = useSessionLane(id, store, desktopStreamingTailSnapshotsEqual);
  const choices = useSessionRouteChoices({
    sessionId: id,
    workflow: snapshot?.workflow ?? null,
    mode: snapshot?.orchestrationMode,
    pendingWorkflow: snapshot?.pendingWorkflowSwitch === true,
    pendingMode: snapshot?.pendingOrchestrationModeSwitch === true,
    disabled: false,
    invokeResult: async (action) => action(),
    applySnapshot() {},
  });
  const label = useRouteLabelParts(choices);
  if (!snapshot) return null;
  const row = (choiceId) => {
    const choice = choices.find((entry) => entry.id === choiceId);
    return choice ? `${choice.valueLabel}${choice.pending ? '*' : ''}` : '-';
  };
  return React.createElement(
    'div',
    null,
    React.createElement('span', { className: 'workflow' }, row('workflow')),
    React.createElement('span', { className: 'mode' }, row('orchestration-mode')),
    React.createElement('span', { className: 'speed' }, String(Boolean(snapshot.fast))),
    React.createElement('span', { className: 'parameters' }, JSON.stringify(snapshot.modelParameters ?? null)),
    React.createElement(
      'span',
      { className: 'context' },
      `${snapshot.contextPercent ?? ''}/${snapshot.contextTokens ?? ''}`
    ),
    React.createElement('span', { className: 'rows' }, (snapshot.items ?? []).map((item) => item.id).join(',')),
    React.createElement('span', { className: 'tail' }, String(live?.streamingTail?.text ?? '')),
    label ? React.createElement(ComposerRouteLabel, { parts: label }) : null
  );
}

async function mounted(id, body) {
  storeWorkflowOptions([
    { value: 'alpha', label: 'Alpha', active: true },
    { value: 'beta', label: 'Beta', active: false },
  ]);
  const lane = rig(id);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const shown = (name) => host.querySelector(`.${name}`)?.textContent ?? null;
  const label = () => host.querySelector('.composer-route-label')?.getAttribute('title') ?? null;
  try {
    await lane.publish();
    await act(async () => root.render(React.createElement(Pane, { id, store: lane.store })));
    await body({ ...lane, shown, label });
  } finally {
    await act(async () => root.unmount());
    lane.dispose();
    host.remove();
  }
}

const workflowNote = (value) => ({ method: 'thread/workflow/updated', params: { value } });

test('a delegation mode staged mid-turn, then applied at the next turn start, shows at once in the picker and the route label', async () => {
  await mounted('picker-mode', async ({ publish, shown, label }) => {
    // The turn streams its reply: the live tail is on screen.
    await publish(
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'a1', text: '', meta: { status: 'inProgress' } } },
      },
      { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'line one\n' } }
    );
    assert.equal(shown('mode'), 'Collaborative');
    assert.equal(shown('tail'), 'line one\n');
    // `thread/setOrchestrationMode {scope: session}` while the turn runs: staged, shown pending.
    await publish(
      workflowNote({
        workflow: alpha,
        orchestrationMode: 'swarm',
        pendingWorkflowSwitch: false,
        pendingOrchestrationModeSwitch: true,
      })
    );
    assert.equal(shown('mode'), 'Swarm*');
    assert.equal(label(), 'Alpha · Swarm');
    assert.equal(shown('rows'), 'u1', 'no settled row is lost');
    assert.equal(shown('tail'), 'line one\n', 'the streaming reply stays');
    // The reply keeps streaming; the staged choice stays.
    await publish({ method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'line two\n' } });
    assert.equal(shown('mode'), 'Swarm*');
    assert.equal(shown('tail'), 'line one\nline two\n');
    // The next turn start applies it (`apply_pending_switches`): no longer pending, the turn already running.
    await publish(
      workflowNote({
        workflow: alpha,
        orchestrationMode: 'swarm',
        pendingWorkflowSwitch: false,
        pendingOrchestrationModeSwitch: false,
      })
    );
    assert.equal(shown('mode'), 'Swarm');
    // Between turns: applied at once.
    await publish(
      workflowNote({
        workflow: alpha,
        orchestrationMode: 'none',
        pendingWorkflowSwitch: false,
        pendingOrchestrationModeSwitch: false,
      })
    );
    assert.equal(shown('mode'), 'Solo');
    assert.equal(label(), 'Alpha · Solo');
  });
});

test('a workflow staged mid-turn shows its name, derived mode and pending mark at once; the turn start that applies it clears the mark', async () => {
  await mounted('picker-workflow', async ({ publish, shown, label }) => {
    await publish(
      {
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'a1', text: '', meta: { status: 'inProgress' } } },
      },
      { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'working\n' } }
    );
    // `thread/setWorkflow {scope: session}` mid-turn: `pendingWorkflowId` with its meta, shown at once and marked pending.
    await publish(
      workflowNote({
        workflow: beta,
        orchestrationMode: 'balanced',
        pendingWorkflowSwitch: true,
        pendingOrchestrationModeSwitch: false,
      })
    );
    assert.equal(shown('workflow'), 'Beta*');
    assert.equal(label(), 'Beta · Collaborative');
    assert.equal(shown('tail'), 'working\n');
    // The turn ends (its reply settles) and the next one starts: busy first, then the staged switch is applied with the
    // workflow's own mode, then its divider amends the anchor row.
    await publish(
      {
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'a1', text: 'working\n', meta: { status: 'completed' } } },
      },
      { method: 'turn/completed', params: { turn: { id: 't1', status: 'completed', items: [] } } }
    );
    await publish({ method: 'turn/started', params: { turn: { id: 't2', status: 'inProgress', items: [] } } });
    await publish(
      workflowNote({
        workflow: beta,
        orchestrationMode: 'swarm',
        pendingWorkflowSwitch: false,
        pendingOrchestrationModeSwitch: false,
      })
    );
    assert.equal(shown('workflow'), 'Beta', 'the pending mark leaves as the switch applies');
    assert.equal(shown('mode'), 'Swarm', 'the mode the applied workflow derives shows with it');
    assert.equal(label(), 'Beta · Swarm');
    assert.equal(shown('rows'), 'u1,a1');
    await publish({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'a1',
          text: 'working\n',
          meta: { status: 'completed', workflowSwitches: [{ fromId: 'alpha', toId: 'beta' }] },
        },
      },
    });
    assert.equal(shown('workflow'), 'Beta');
    assert.equal(label(), 'Beta · Swarm');
  });
});

test('speed, parameters and context changes on the seated model show at once', async () => {
  await mounted('picker-speed', async ({ publish, shown }) => {
    const route = {
      provider: 'openai',
      model: 'gpt-a',
      effort: 'low',
      fast: false,
      autoEffort: false,
      modelParameters: {},
    };
    await publish({ method: 'thread/route/updated', params: { value: { ...route, fast: true } } });
    assert.equal(shown('speed'), 'true');
    await publish({
      method: 'thread/route/updated',
      params: { value: { ...route, fast: true, modelParameters: { verbosity: 'low' } } },
    });
    assert.equal(shown('parameters'), '{"verbosity":"low"}');
    await publish({
      method: 'thread/context/updated',
      params: { value: { contextPercent: 50, contextTokens: 200000 } },
    });
    assert.equal(shown('context'), '50/200000');
  });
});

test("a pane's view of a positioned state carries the window's facts to the transcript", () => {
  const facts = {
    transcriptPositioned: true,
    transcriptWindowVersion: 7,
    transcriptViewItems: [{ id: 'r1' }],
    transcriptHistoryBefore: true,
    transcriptHistoryAfter: true,
  };
  const view = paneConversationView({ sessionId: 's', items: [{ id: 'r9' }], ...facts });
  assert.deepEqual(Object.fromEntries(Object.keys(facts).map((key) => [key, view[key]])), facts);
});
