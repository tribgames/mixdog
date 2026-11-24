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
    moveTranscriptWindow: async (_sessionId, move) => {
      moves.push(move.kind);
      return true;
    },
  };
  const tail = Array.from({ length: 400 }, (_, index) => ({ id: `r${index}` }));
  const facts = (version, viewItems = null) => ({
    views: viewItems ? [{ items: viewItems, older: false, newer: false }] : [],
    version,
  });
  let shown;
  function Pane({ positioned }) {
    shown = useTranscriptWindow('s', tail, true, true, undefined, undefined, positioned).items;
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    // The tail grows as records arrive: each is another window version.
    for (const version of [1, 2, 3])
      await act(async () => root.render(React.createElement(Pane, { positioned: facts(version) })));
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

test('a positioned pane tells the window where its reader is, and that the view follows the end when it does', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><main></main>',
    jsdom: { url: 'https://mixdog.test/' },
  });
  const { createRoot } = await import('react-dom/client');
  const { useTranscriptWindow } = await import('./use-transcript-history.ts');
  const moves = [];
  window.mixdogDesktop = {
    moveTranscriptWindow: async (_sessionId, move) => {
      moves.push(move);
      return true;
    },
  };
  const rows = Array.from({ length: 300 }, (_, index) => ({ id: `r${index}` }));
  const facts = { views: [], version: 1 };
  let window_;
  function Pane({ following }) {
    window_ = useTranscriptWindow('s', rows, true, following, undefined, undefined, facts);
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Pane, { following: false })));
    await act(async () => window_.readerAt('r10', 'r20'));
    assert.deepEqual(moves, [{ kind: 'read', first: 'r10', last: 'r20', reader: '' }], 'a place to come back to');
    await act(async () => root.render(React.createElement(Pane, { following: true })));
    await act(async () => window_.readerAt('r280', 'r299'));
    assert.deepEqual(
      moves.at(-1),
      { kind: 'read', first: 'r280', last: 'r299', end: true, reader: '' },
      'the end is none'
    );
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('each move goes out as it is asked, for its own session; a pane that shows another withdraws from the one it left', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><main></main>',
    jsdom: { url: 'https://mixdog.test/' },
  });
  const { createRoot } = await import('react-dom/client');
  const { useTranscriptWindow } = await import('./use-transcript-history.ts');
  const sent = [];
  window.mixdogDesktop = {
    moveTranscriptWindow: (sessionId, move) => {
      const out = Promise.withResolvers();
      sent.push({ sessionId, first: move.first ?? move.kind, reader: move.reader, answer: out.resolve });
      return out.promise;
    },
  };
  const rows = Array.from({ length: 300 }, (_, index) => ({ id: `r${index}` }));
  const facts = { views: [], version: 1 };
  let window_;
  function Pane({ session }) {
    window_ = useTranscriptWindow(session, rows, true, false, undefined, undefined, facts);
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  const told = () => sent.map((move) => [move.sessionId, move.first]);
  try {
    await act(async () => root.render(React.createElement(Pane, { session: 'A' })));
    await act(async () => window_.readerAt('r10', 'r20'));
    // The reader moves on while the page is out: the window is told where it is now, not when the page returns.
    await act(async () => window_.readerAt('r30', 'r40'));
    assert.deepEqual(told(), [
      ['A', 'r10'],
      ['A', 'r30'],
    ]);
    // The pane shows another session: it withdraws from A at once, and its move is B's own.
    await act(async () => root.render(React.createElement(Pane, { session: 'B' })));
    await act(async () => window_.readerAt('r50', 'r60'));
    assert.deepEqual(told(), [
      ['A', 'r10'],
      ['A', 'r30'],
      ['A', 'follow'],
      ['B', 'r50'],
    ]);
    // A's pages return: nothing of A is asked of B, and nothing more of A.
    await act(async () => sent[0].answer(true));
    await act(async () => sent[1].answer(true));
    assert.equal(sent.length, 4);
    // The pane closes: it withdraws from the session it showed.
    await act(async () => root.render(null));
    assert.deepEqual(told().at(-1), ['B', 'follow']);
    assert.equal(sent.at(-1).reader, sent[3].reader, 'as the reader that read it');
  } finally {
    for (const move of sent) move.answer(false);
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
