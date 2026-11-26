import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { createTranscriptRowNodes } from './transcript-list-row-nodes.ts';

test('renderTranscriptRow keeps a stable identity across unrelated Conversation state updates', async (t) => {
  const { root } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  const { useConversationRowRenderer } = await import('./use-conversation-row-renderer.ts');

  const settledItems = [
    { id: 'u1', kind: 'user', text: 'hello' },
    { id: 'a1', kind: 'assistant', text: 'world' },
  ];
  const settledTurnKeys = ['turn:u1', 'turn:u1'];
  const rows = [
    { _tag: 'UserMessage', key: 'u1', turnKey: 'turn:u1', item: settledItems[0] },
    { _tag: 'AssistantPart', key: 'a1', turnKey: 'turn:u1', item: settledItems[1] },
  ];

  const renderAssistantRow = (props) => React.createElement('div', null, props.item.text);
  const seenRenderers = [];
  const openedSettings = [];
  const submitted = [];
  let updateProps;

  function Harness() {
    const [state, setState] = React.useState({
      snapshot: {
        sessionId: 's1',
        busy: false,
        contextPercent: 10,
        stats: { inputTokens: 100 },
        model: 'gpt-5',
        queued: [],
        activeTools: {},
      },
      disclosureScope: 's1',
      readOnly: false,
      transitioning: false,
      settingsTag: 'first',
      agentMode: false,
      questionCard: null,
    });
    updateProps = (patch) => setState((prev) => ({ ...prev, ...patch }));
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: state.snapshot,
      disclosureScope: state.disclosureScope,
      readOnly: state.readOnly,
      transitioning: state.transitioning,
      renderAssistantRow,
      onOpenSettings: (section) => openedSettings.push([state.settingsTag, section]),
      settledItems,
      settledTurnKeys,
      optimisticActivityStartedAt: 0,
      submit: async (prompt, options) => {
        submitted.push([state.settingsTag, prompt, options]);
        return true;
      },
      questionCard: state.questionCard,
      agentMode: state.agentMode,
    });
    seenRenderers.push(renderTranscriptRow);
    return null;
  }

  await act(async () => root.render(React.createElement(Harness)));
  assert.equal(seenRenderers.length, 1);
  const initialRenderer = seenRenderers[0];

  // Unrelated snapshot fields and fresh callback closures must not invalidate renderTranscriptRow.
  await act(async () => {
    updateProps({
      snapshot: {
        sessionId: 's1',
        busy: false,
        contextPercent: 42,
        stats: { inputTokens: 999 },
        model: 'gpt-5-mini',
        queued: [{ id: 'q1' }],
        activeTools: { shell: { count: 2, startedAt: 100 } },
        shellJobs: { count: 0, jobs: [] },
      },
      settingsTag: 'second',
    });
  });
  assert.equal(seenRenderers.length, 2);
  assert.equal(
    seenRenderers[1],
    initialRenderer,
    'unrelated Conversation state updates preserve renderTranscriptRow identity'
  );

  // TranscriptList memoization keyed by [rows, renderRow] keeps the same node cache.
  const cachedNodes = createTranscriptRowNodes(rows, seenRenderers[1]);
  assert.equal(cachedNodes.nodeAt(0), cachedNodes.nodeAt(0));

  // Latest onOpenSettings and submit refs are still called even though renderTranscriptRow identity did not change.
  const errorRow = {
    _tag: 'Error',
    key: 'err-1',
    turnKey: 'turn:u1',
    failures: [{ turnKey: 'turn:u1', item: { kind: 'error', errorKind: { kind: 'auth' }, text: '401 Unauthorized' } }],
  };
  const errorNode = seenRenderers[1](errorRow, 0, [errorRow]);
  assert.ok(errorNode?.props?.action?.props?.onClick);
  errorNode.props.action.props.onClick();
  assert.deepEqual(openedSettings, [['second', 'providers']]);
  assert.ok(typeof errorNode?.props?.onRetry === 'function');
  errorNode.props.onRetry();
  await Promise.resolve();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0][0], 'second');

  // Row-relevant state changes (e.g. busy, readOnly, disclosureScope, agentMode) must refresh identity.
  await act(async () => {
    updateProps({ readOnly: true });
  });
  assert.notEqual(seenRenderers[2], initialRenderer, 'readOnly change invalidates renderTranscriptRow');
  const readOnlyRenderer = seenRenderers[2];

  await act(async () => {
    updateProps({
      snapshot: {
        sessionId: 's1',
        busy: true,
        spinner: { active: true, mode: 'thinking', startedAt: 1 },
      },
    });
  });
  assert.notEqual(seenRenderers[3], readOnlyRenderer, 'busy/live spinner change invalidates renderTranscriptRow');
});
