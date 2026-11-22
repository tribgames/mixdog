import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

test('a positioned pane following a tail grown long asks the core for nothing; a stretch opened apart is let go once', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><main></main>',
    jsdom: { url: 'https://mixdog.test/' },
  });
  const { createRoot } = await import('react-dom/client');
  const { useTranscriptWindow } = await import('./use-transcript-history.ts');
  const moves = [];
  window.mixdogDesktop = {
    moveTranscriptWindow: async (sessionId, move) => {
      moves.push(move.kind);
      return true;
    },
  };
  const tail = Array.from({ length: 400 }, (_, index) => ({ id: `r${index}` }));
  const facts = (version, viewItems = null) => ({ viewItems, viewOlder: false, viewNewer: false, version });
  let shown;
  function Pane({ positioned }) {
    shown = useTranscriptWindow('s', tail, true, true, undefined, undefined, positioned).items;
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    // The tail grows as records arrive: each is another window version.
    for (const version of [1, 2, 3]) await act(async () => root.render(React.createElement(Pane, { positioned: facts(version) })));
    assert.deepEqual(moves, [], 'no tail is read anew, whatever its length');
    assert.equal(shown.length, 400, 'every row followed stays shown');
    // A stretch opened apart from the tail (a search hit), with the reader following again.
    await act(async () => root.render(React.createElement(Pane, { positioned: facts(4, [{ id: 'hit' }]) })));
    assert.deepEqual(moves, ['follow']);
    await act(async () => root.render(React.createElement(Pane, { positioned: facts(5) })));
    assert.deepEqual(moves, ['follow'], 'and nothing more once it is gone');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('sending from history shows the live conversation without waiting for another page or host acknowledgement', async () => {
  const { document, restore } = installTestDom(null, {
    html: '<!doctype html><main></main>',
    jsdom: { url: 'https://mixdog.test/' },
  });
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
    const submission = useConversationSubmission(
      { snapshot, routeSnapshot: snapshot, submit: () => host.promise },
      {
        draftMode: false,
        settledItems: items,
        transcriptSessionKey: 's',
        routeSessionIdRef: { current: 's' },
        armFollow: () => follow(true),
        resetTranscriptToLive: history.resetToLive,
        promotedOwnDraft: { current: false },
        suppressDraftSubmitPaintHandoff: { current: false },
      }
    );
    page = history.requestEarlier;
    send = submission.actions.composerSubmit;
    publish = setItems;
    return [...history.items, ...submission.transcriptPendingPromptItems].map((row) =>
      React.createElement('p', { key: row.id }, row.text)
    );
  }
  const main = document.querySelector('main');
  const root = createRoot(main);
  try {
    await act(async () => root.render(React.createElement(Pane)));
    await act(async () => page());
    await act(async () => {
      void send('new prompt', { id: 'sent' });
    });
    assert.match(main.textContent, /new prompt/);
    await act(async () =>
      older.resolve({ items: [{ id: 'b', text: 'earlier reply' }], hasOlder: false, hasNewer: true })
    );
    await act(async () =>
      publish([...live, { id: 'sent', kind: 'user', text: 'new prompt' }, { id: 'reply', text: 'new reply' }])
    );
    assert.deepEqual(
      [...main.querySelectorAll('p')].map((p) => p.textContent),
      ['latest reply', 'new prompt', 'new reply']
    );
    await act(async () => host.resolve(true));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
