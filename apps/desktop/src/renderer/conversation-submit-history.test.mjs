import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

test('sending from history shows the live conversation without waiting for another page or host acknowledgement', async () => {
  const { document, restore } = installTestDom(null, { html: '<!doctype html><main></main>', jsdom: { url: 'https://mixdog.test/' } });
  const { createRoot } = await import('react-dom/client');
  const { useTranscriptWindow } = await import('./use-transcript-history.ts');
  const { useConversationSubmission } = await import('./use-conversation-submission.ts');
  const host = Promise.withResolvers();
  const live = [{ id: 'a', kind: 'assistant', text: 'latest reply' }];
  const older = Promise.withResolvers();
  window.mixdogDesktop = { readTranscriptHistory: () => older.promise };
  const snapshot = { sessionId: 's', items: live };
  let page, send, publish;
  function Pane() {
    const [items, setItems] = useState(live);
    const [following, follow] = useState(false);
    const history = useTranscriptWindow('s', items, true, following);
    const submission = useConversationSubmission({ snapshot, routeSnapshot: snapshot, submit: () => host.promise }, {
      draftMode: false, settledItems: items, transcriptSessionKey: 's', routeSessionIdRef: { current: 's' },
      armFollow: () => follow(true), resetTranscriptToLive: history.resetToLive,
      promotedOwnDraft: { current: false }, suppressDraftSubmitPaintHandoff: { current: false },
    });
    page = history.requestEarlier;
    send = submission.actions.composerSubmit;
    publish = setItems;
    return [...history.items, ...submission.transcriptPendingPromptItems].map((row) => React.createElement('p', { key: row.id }, row.text));
  }
  const main = document.querySelector('main');
  const root = createRoot(main);
  try {
    await act(async () => root.render(React.createElement(Pane)));
    await act(async () => page());
    await act(async () => { void send('new prompt', { id: 'sent' }); });
    assert.match(main.textContent, /new prompt/);
    await act(async () => older.resolve({ items: [{ id: 'b', text: 'earlier reply' }], hasOlder: false, hasNewer: true }));
    await act(async () => publish([...live, { id: 'sent', kind: 'user', text: 'new prompt' }, { id: 'reply', text: 'new reply' }]));
    assert.deepEqual([...main.querySelectorAll('p')].map((p) => p.textContent), ['latest reply', 'new prompt', 'new reply']);
    await act(async () => host.resolve(true));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
