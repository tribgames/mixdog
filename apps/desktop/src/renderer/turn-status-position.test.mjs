import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { projectSettledTranscriptRows } from './transcript-rows.ts';
import { transcriptRowNode } from './conversation-support.tsx';
import { TranscriptResponseFooter, TranscriptRow } from './transcript-row.tsx';
import { PreviewedTurnChangesCard } from './transcript-visualize-card.tsx';

const complete = { kind: 'turndone', id: 'd1', status: 'complete' };
const reply = { kind: 'assistant', id: 'a1', text: 'done' };

function project(items) {
  let turn = '';
  const turnKeys = items.map((item) => {
    if (item.kind === 'user') turn = `turn:${item.id}`;
    return turn;
  });
  return projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set() }).rows;
}

function rowChildren(row, extra = {}) {
  const node = transcriptRowNode(row, {
    disclosureScope: 's',
    optimisticActivityStartedAt: 0,
    readOnly: false,
    renderAssistantRow: (props) => ({ assistantProps: props }),
    retryDisabled: false,
    settledItems: [],
    settledTurnKeys: [],
    snapshot: { sessionId: 's' },
    onRetryTurn() {},
    onOpenSettings() {},
    ...extra,
  });
  return node;
}

test('a row with a changed-files card puts the response footer after the card', () => {
  const row = project([{ kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' }, reply, complete]).find(
    (candidate) => candidate.turnChanges
  );
  const children = rowChildren(row, { turnCards: { cards: 'VISUALIZE', placed: false } }).props.children;
  const changesAt = children.findIndex((child) => child?.type === PreviewedTurnChangesCard);
  assert.ok(changesAt > 0);
  assert.equal(children.at(-1)?.type, TranscriptResponseFooter);
  assert.equal(children.length - 1, changesAt + 1);
  assert.equal(children[0].assistantProps.footerAfterCards, true);
});

test('a row without cards keeps its footer inside the message', () => {
  const row = project([reply, complete]).find((candidate) => candidate._tag === 'AssistantPart');
  assert.equal(row.turnChanges, undefined);
  const node = rowChildren(row);
  assert.deepEqual(Object.keys(node), ['assistantProps']);
  assert.equal(node.assistantProps.footerAfterCards, undefined);
});

function mount(t) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { pretendToBeVisual: true },
    expose: ['HTMLElement', 'Element', 'Node', 'CustomEvent', 'MutationObserver'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.mixdogDesktop = {};
  return { root, document: dom.window.document };
}

test('the trailing footer swaps waiting, complete, waiting in one DOM node', async (t) => {
  const { root, document } = mount(t);
  const footer = (backgroundWork) =>
    React.createElement(TranscriptResponseFooter, {
      trailing: true,
      item: reply,
      completion: complete,
      backgroundWork,
    });
  await act(async () => root.render(footer({ shell: 1, agent: 0 })));
  const node = document.querySelector('.response-footer-trailing');
  assert.ok(node);
  const waiting = node.querySelector('.turn-status')?.textContent;
  await act(async () => root.render(footer(undefined)));
  assert.equal(document.querySelector('.response-footer-trailing'), node);
  assert.notEqual(node.querySelector('.turn-status')?.textContent, waiting);
  await act(async () => root.render(footer({ shell: 0, agent: 2 })));
  assert.equal(document.querySelector('.response-footer-trailing'), node);
  assert.equal(node.querySelectorAll('.turn-status').length, 1);
  assert.ok(node.querySelector('.message-actions'));
});

test('footerAfterCards leaves the footer out of the message; default keeps it in', async (t) => {
  const { root, document } = mount(t);
  const row = (footerAfterCards) =>
    React.createElement(TranscriptRow, { item: reply, completion: complete, footerAfterCards });
  await act(async () => root.render(row(false)));
  assert.ok(document.querySelector('article.message .response-footer'));
  await act(async () => root.render(row(true)));
  assert.equal(document.querySelector('.response-footer'), null);
});
