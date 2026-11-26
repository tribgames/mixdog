import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TranscriptAssistantRow } from './TranscriptAssistantRow';
import { TranscriptRow } from './transcript-row';
import { ComposerDock } from './ComposerDock';
import { TranscriptArtifacts } from './transcript-artifacts-ui';
import { leadReviewCheckpointIdCache, leadReviewFilesCache, rememberAgentReviews } from './turn-review-cache';
import { turnReviewScope } from './turn-review-scope.ts';
import { preloadMarkdownBody } from './markdown-body-loader';
import { parseStreamingMarkdownAst } from './markdown-worker-client';
import {
  _transcriptLifecycleStatsForTest,
  releaseTranscriptRowLifecycle,
  useTranscriptRows,
} from './use-conversation-rows';
import { rememberTranscriptRowNamespace } from './transcript-virtual-cache';
import { turnOf } from './conversation-turn-index';

function mount(t) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { pretendToBeVisual: true },
    expose: ['HTMLElement', 'Element', 'Node', 'CustomEvent', 'MutationObserver'],
    rootId: 'root',
  });
  // jsdom has no layout, so nothing ever resizes: the review lift observer
  // only needs to exist.
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  t.after(() => {
    globalThis.ResizeObserver = previousResizeObserver;
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.mixdogDesktop = {};
  return { root, document: dom.window.document, window: dom.window };
}

test('settling an assistant preserves its rendered Markdown without an empty intermediate commit', async (t) => {
  const { root, document } = mount(t);
  const text = '**Already rendered answer** with unchanged text.';
  await preloadMarkdownBody();
  await parseStreamingMarkdownAst(text);
  const item = { kind: 'assistant', id: 'answer', text, streaming: true };
  await act(async () => root.render(React.createElement(TranscriptAssistantRow, { item, live: true })));
  const body = document.querySelector('.markdown');
  const strong = body.querySelector('strong');
  const expectedText = body.textContent;
  assert.ok(strong);
  // A reply watched streaming breaks lines greedily (22-markdown.css), so its
  // words never re-wrap as it grows, and settling keeps that: no reflow.
  assert.ok(body.classList.contains('streamed'));
  act(() => {
    root.render(
      React.createElement(TranscriptAssistantRow, {
        item: { ...item, streaming: false },
        live: false,
        completion: { kind: 'turndone', status: 'complete', elapsedMs: 12_000 },
      })
    );
  });
  assert.equal(document.querySelector('.markdown'), body);
  assert.equal(document.querySelector('.markdown strong'), strong);
  assert.equal(body.textContent, expectedText);
  assert.ok(body.classList.contains('streamed'));
  assert.equal(document.querySelector('[data-transcript-pending]'), null);
  assert.ok(document.querySelector('.response-footer'));
  // A settled reply mounted whole keeps the pretty line breaks.
  act(() => root.render(React.createElement('div')));
  act(() => {
    root.render(
      React.createElement(TranscriptAssistantRow, { item: { ...item, id: 'history', streaming: false }, live: false })
    );
  });
  assert.equal(document.querySelector('.markdown').classList.contains('streamed'), false);
});

test('a completed reply takes the live band’s place: no band lingers below its footer while busy', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'prompt', text: 'Answer briefly' };
  const reply = { kind: 'assistant', id: 'reply', text: 'Done.' };
  const done = { kind: 'turndone', id: 'done', status: 'done', verb: 'Completed', elapsedMs: 1_000 };
  let tags = [];
  function Rows(props) {
    const settledItems = props.items;
    const { transcriptRows } = useTranscriptRows({
      identity: 'band-session',
      sessionKey: 'band-session',
      settledItems,
      settledRowItems: settledItems,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: props.pendingItems ?? [],
      liveItem: props.liveItem ?? null,
      busy: props.busy,
      commandBusy: false,
      commandActivityVisible: props.activity ?? false,
      optimisticActivityStartedAt: 0,
    });
    tags = transcriptRows.map((row) => row._tag);
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Rows, props)));
  await render({ items: [prompt], liveItem: { ...reply, streaming: true }, busy: true });
  assert.deepEqual(tags, ['UserMessage', 'AssistantPart', 'Thinking'], 'streaming: the band sits under the reply');
  await render({ items: [prompt, reply, done], busy: true });
  assert.deepEqual(
    tags,
    ['UserMessage', 'AssistantPart'],
    'the footer replaced the band; a busy flag alone keeps none'
  );
  await render({ items: [prompt, reply, done], busy: true, activity: true });
  assert.deepEqual(tags, ['UserMessage', 'AssistantPart', 'Thinking'], 'visible activity brings the band back');
  await render({ items: [prompt, reply], busy: true });
  assert.deepEqual(
    tags,
    ['UserMessage', 'AssistantPart', 'Thinking'],
    'an open turn keeps its band through null activity'
  );
  await render({ items: [prompt, reply, done, { kind: 'user', id: 'wake', text: 'next', hidden: true }], busy: true });
  assert.deepEqual(
    tags,
    ['UserMessage', 'AssistantPart', 'TurnGap', 'Thinking'],
    'a hidden follow-up turn keeps the band, as that turn’s own'
  );
});

test('a finished turn keeps its footer and cards while activity is reported around its end', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'prompt', text: 'Change a file', at: 1_000 };
  const reply = { kind: 'assistant', id: 'reply', text: 'Done.', at: 4_000 };
  const done = { kind: 'turndone', id: 'done', status: 'done', verb: 'Completed', elapsedMs: 3_000, at: 4_000 };
  let rows = [];
  let ended = false;
  function Rows(props) {
    const settledItems = props.items;
    const { transcriptRows, turnPastEnd } = useTranscriptRows({
      identity: 'end-session',
      sessionKey: 'end-session',
      settledItems,
      settledRowItems: settledItems,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy: true,
      commandBusy: false,
      commandActivityVisible: true,
      commandActivityStartedAt: props.activityStartedAt,
      optimisticActivityStartedAt: 0,
    });
    rows = transcriptRows;
    ended = turnPastEnd;
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Rows, props)));
  const tags = () => rows.map((row) => row._tag);
  // The turn's end is recorded while its own activity is still reported: the footer takes the band's place in the
  // commit that shows it, so the two never stand together and the row never loses the band's height a frame later.
  await render({ items: [prompt, reply], activityStartedAt: 1_000 });
  assert.deepEqual(tags(), ['UserMessage', 'AssistantPart', 'Thinking']);
  await render({ items: [prompt, reply, done], activityStartedAt: 1_000 });
  assert.deepEqual(tags(), ['UserMessage', 'AssistantPart'], 'the ended turn’s own activity keeps no band');
  // The next turn is reported running before its prompt is recorded: its band opens a turn of its own, and the
  // finished turn still ends at its reply (use-conversation-row-renderer.ts draws its cards and footer there).
  await render({ items: [prompt, reply, done], activityStartedAt: 9_000 });
  assert.deepEqual(tags(), ['UserMessage', 'AssistantPart', 'TurnGap', 'Thinking']);
  const finished = turnOf(rows, rows[1].turnKey);
  assert.equal(finished.running, false, 'the finished turn is not running again');
  assert.equal(finished.lastRow, 1);
  assert.notEqual(rows.at(-1).turnKey, rows[1].turnKey);
  assert.equal(ended, true, 'nothing of the running turn is placed: the trailing changed-files card is not its own');
  await render({
    items: [prompt, reply, done, { kind: 'user', id: 'next', text: 'More', at: 9_100 }],
    activityStartedAt: 9_000,
  });
  assert.deepEqual(tags(), ['UserMessage', 'AssistantPart', 'TurnGap', 'UserMessage', 'Thinking']);
  assert.equal(ended, false);
});

test('a group room keeps one typing slot row through its turns; the typing rows open none', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'desktop-submit-1', text: 'hello room' };
  const typing = {
    kind: 'notice',
    id: 'room-typing-1',
    tone: 'info',
    text: 'GH…',
    room: { kind: 'typing', speaker: 'gh' },
  };
  let keys = [];
  function Rows(props) {
    const { transcriptRows } = useTranscriptRows({
      identity: 'sess_room_r1',
      sessionKey: 'sess_room_r1',
      settledItems: props.items,
      settledRowItems: props.items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: props.pendingItems ?? [],
      liveItem: null,
      busy: true,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: props.optimistic ?? 0,
      room: true,
    });
    keys = transcriptRows.map((row) => `${row._tag}:${row.key}`);
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Rows, props)));
  const pending = { ...prompt, pending: true, accepted: true, submittedAt: 1 };
  await render({ items: [], pendingItems: [pending], optimistic: 1 });
  const sent = keys;
  assert.ok(sent.at(-1).startsWith('Thinking:'), 'the slot opens on send');
  await render({ items: [prompt, typing] });
  // The settled row keeps the pending bubble's key: no remount at the flat estimate.
  assert.deepEqual(keys, sent, 'the typing row paints in the slot: same rows, same keys');
  // Between turns the typing row is gone; the next one has a fresh id.
  await render({ items: [prompt] });
  assert.deepEqual(keys, sent, 'between turns the slot stays');
  const speech = { kind: 'notice', id: 'row_s1', text: 'hi', room: { kind: 'speech', speaker: 'gh' } };
  const pass = { kind: 'notice', id: 'row_p1', room: { kind: 'pass', speaker: 'cx' } };
  await render({
    items: [prompt, speech, pass, { ...typing, id: 'room-typing-2', room: { kind: 'typing', speaker: 'cx' } }],
  });
  assert.equal(keys.at(-1), sent.at(-1), 'one slot key for the whole run');
  assert.equal(keys.filter((key) => key.startsWith('Thinking:')).length, 1);
  assert.equal(keys.filter((key) => key.includes('room-typing')).length, 0, 'no typing row of its own');
});

async function settleIslandReview(t, hasDiff) {
  const { root, document, window } = mount(t);
  // ComposerDock loads the review module lazily; with the chunk cached it
  // mounts in the first commit.
  await import('./TurnReview');
  // The island segment summarizes the whole session from the runtime's
  // session diff; the turn review read still backs the expanded file list.
  const pending = [];
  const sessionPending = [];
  window.mixdogDesktop.invokeCapability = (request) => {
    const queue = { getTurnReviewDiff: pending, getSessionReviewDiff: sessionPending }[request.capability];
    assert.ok(queue, `unexpected capability ${request.capability}`);
    return new Promise((resolve) => queue.push(resolve));
  };
  const sessionId = `review-completion-${hasDiff}`;
  const items = [
    { kind: 'user', id: 'prompt', text: 'Change a file' },
    { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated demo.ts' },
  ];
  const scope = turnReviewScope(items).key;
  rememberAgentReviews(`${sessionId}:${scope}`, [], '', [], 'worktree', scope);
  const props = {
    // The island mounts once the session's first lane snapshot has named it.
    sessionId,
    goalSubmissionId: '',
    showProjectSelector: false,
    reviewActive: true,
    reviewSessionId: sessionId,
    reviewCwd: 'C:/work',
    children: React.createElement('textarea'),
  };
  const render = (busy, reviewItems) =>
    act(async () => root.render(React.createElement(ComposerDock, { ...props, reviewItems, reviewBusy: busy })));
  const segment = () => document.querySelector('.turn-review-segment');
  const islandSlot = () => document.querySelector('.composer-island-slot');
  await render(true, items);
  const slot = islandSlot();
  assert.equal(pending.length, 1);
  assert.equal(segment(), null, 'an in-flight read shows no files segment');
  await render(false, [...items, { kind: 'turndone', id: 'done', status: 'complete' }]);
  assert.equal(segment(), null);
  const response = (files) => ({
    value: {
      supported: true,
      authoritative: true,
      snapshotKind: 'worktree',
      checkpointId: scope,
      patch: '',
      files,
      agents: [],
    },
  });
  const answerSession = (files) =>
    act(async () => {
      for (const resolve of sessionPending.splice(0))
        resolve({ value: { ...response(files).value, checkpointId: '' } });
    });
  await act(async () => pending.shift()(response([])));
  assert.equal(pending.length, 1);
  assert.equal(segment(), null, 'an empty response renders nothing');
  const finalFiles = hasDiff ? [{ path: 'demo.ts', status: 'M', additions: 1, deletions: 1 }] : [];
  await act(async () => pending.shift()(response(finalFiles)));
  await answerSession(finalFiles);
  return { root, document, window, segment, islandSlot, slot, pending };
}

for (const hasDiff of [true, false]) {
  test(`the island files segment ${hasDiff ? 'appears' : 'stays absent'} once the session diff read finds ${hasDiff ? 'changes' : 'an empty final diff'}`, async (t) => {
    const { root, document, segment, islandSlot, slot, pending } = await settleIslandReview(t, hasDiff);
    assert.equal(document.querySelector('.turn-review-bar'), null, 'the review bar left the composer stack');
    assert.equal(Boolean(segment()), hasDiff);
    if (hasDiff) assert.equal(segment().closest('.composer-island-pill')?.parentElement?.className, 'composer-island');
    assert.ok(slot);
    assert.equal(islandSlot(), slot, 'the island slot stays mounted whatever it shows');
    assert.equal(pending.length, 0);
    await act(async () => root.render(null));
  });
}

test('the island segment shows its counts and expands to the turn file list until Escape', async (t) => {
  const { root, document, window, segment } = await settleIslandReview(t, true);
  assert.match(segment().textContent, /\+1 −1$/, 'a space separates the line counts');
  assert.match(segment().textContent, /^1 file\+1/, 'the count in words, singular for one file');
  assert.ok(segment().firstElementChild.classList.contains('composer-island-seg-icon'), 'the file glyph leads');
  assert.equal(segment().querySelector('.composer-island-seg-num').dataset.count, '1');
  // No side dock here (no onOpenSessionDiff): the segment's View changes
  // expands the island to the turn's file list in place, and Escape
  // collapses it.
  await act(async () => segment().click());
  await act(async () => document.querySelector('.turn-review-files-menu [role="menuitem"]').click());
  assert.equal(document.querySelector('.composer-island').dataset.expanded, 'files');
  const bar = document.querySelector('.composer-island-pill > .turn-review-bar');
  assert.equal(bar?.dataset.expanded, 'true');
  assert.match(bar.querySelector('.turn-review-files').textContent, /demo\.ts/);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('.composer-island').dataset.expanded, undefined);
  assert.ok(segment(), 'collapsing returns to the segment');
  await act(async () => root.render(null));
});

test('the island slot belongs to one session: a switch starts a fresh slot instead of animating the old one', async (t) => {
  const { root, document, window } = mount(t);
  await import('./TurnReview');
  window.mixdogDesktop.invokeCapability = () => new Promise(() => {});
  const render = (reviewSessionId) =>
    act(async () =>
      root.render(
        React.createElement(
          ComposerDock,
          {
            sessionId: reviewSessionId,
            goalSubmissionId: '',
            showProjectSelector: false,
            reviewActive: false,
            reviewSessionId,
            reviewCwd: 'C:/work',
            reviewItems: [],
          },
          React.createElement('textarea')
        )
      )
    );
  const islandSlot = () => document.querySelector('.composer-island-slot');
  const composer = () => document.querySelector('textarea');
  await render('session-a');
  const slotA = islandSlot();
  const input = composer();
  assert.ok(slotA);
  await render('session-a');
  assert.equal(islandSlot(), slotA, 'the same session keeps its slot');
  await render('session-b');
  assert.ok(islandSlot());
  assert.notEqual(islandSlot(), slotA, 'a new session never inherits the outgoing slot height');
  assert.equal(composer(), input, 'only the island is replaced; the composer input survives the switch');
  await act(async () => root.render(null));
});

test('a transcript tail without its prompt row keeps the turn review of that turn', async (t) => {
  const { root, window } = mount(t);
  await import('./TurnReview');
  const pending = [];
  // Only the turn review read is observed; the session diff is left unanswered.
  window.mixdogDesktop.invokeCapability = (request) =>
    new Promise((resolve) => (request.capability === 'getTurnReviewDiff' ? pending : []).push(resolve));
  const sessionId = 'review-truncated';
  // An earlier read under the shared `none` scope left an unrelated review.
  rememberAgentReviews(
    `${sessionId}:none`,
    [],
    '',
    [{ path: 'stale.ts', additions: 900, deletions: 40 }],
    'worktree',
    'old'
  );
  const edit = (id) => ({ kind: 'tool', id, name: 'apply_patch', args: {}, result: `Updated ${id}` });
  const render = (reviewItems) =>
    act(async () =>
      root.render(
        React.createElement(
          ComposerDock,
          {
            sessionId,
            goalSubmissionId: '',
            showProjectSelector: false,
            reviewActive: true,
            reviewBusy: false,
            reviewSessionId: sessionId,
            reviewCwd: 'C:/work',
            reviewItems,
          },
          React.createElement('textarea')
        )
      )
    );
  const answer = (checkpointId, path, additions = 1) =>
    act(async () => {
      for (const resolve of pending.splice(0)) {
        resolve({
          value: {
            supported: true,
            authoritative: true,
            snapshotKind: checkpointId === 'prompt' ? 'worktree' : 'scoped',
            checkpointId,
            patch: '',
            files: [{ path, status: 'M', additions, deletions: 1 }],
            agents: [],
          },
        });
      }
    });
  // The island segment is session-wide and no longer draws the turn review, so
  // the turn's read is observed through the review cache it feeds, keyed by
  // the turn's scope. Nothing is ever cached under the shared `none` scope.
  const cached = (scope) => leadReviewFilesCache.get(`${sessionId}:${scope}`)?.map((file) => file.path);
  await render([{ kind: 'user', id: 'prompt', text: 'Change a file' }, edit('edit-1')]);
  await answer('prompt', 'demo.ts');
  assert.deepEqual(cached('prompt'), ['demo.ts']);
  // The daemon re-cut its tail: the prompt row is gone, the turn goes on, and
  // its reads still land under the prompt's scope (not the shared `none`).
  await render([edit('edit-1'), edit('edit-2')]);
  assert.equal(pending.length, 1, 'the truncated tail re-reads the turn review');
  await answer('prompt', 'next.ts');
  assert.deepEqual(cached('prompt'), ['next.ts']);
  // A previous turn's recorded review still fails the checkpoint check.
  await render([edit('edit-1'), edit('edit-2'), edit('edit-3')]);
  assert.equal(pending.length, 1);
  await answer('old', 'stale.ts', 900);
  assert.deepEqual(cached('prompt'), ['next.ts']);
  assert.equal(leadReviewCheckpointIdCache.get(`${sessionId}:none`), 'old', 'the unrelated `none` entry is untouched');
});

test('media preview frames survive decoding, metadata and fallback failures', async (t) => {
  const { root, document, window } = mount(t);
  window.mixdogDesktop.mediaUrl = (id, variant) => `https://mixdog.test/media/${id}/${variant}`;
  const items = ['image', 'video'].map((kind) => ({
    kind: 'tool',
    name: 'media',
    args: { action: 'generate', kind },
    result: { ok: true, status: 'done', kind, assetId: kind },
  }));
  await act(async () => root.render(React.createElement(TranscriptArtifacts, { items })));
  const frames = [...document.querySelectorAll('.transcript-artifact-frame')];
  assert.equal(frames.length, 2);
  const [image, poster] = document.querySelectorAll('.transcript-artifact-frame img');
  await act(async () => {
    image.dispatchEvent(new window.Event('load'));
    poster.dispatchEvent(new window.Event('load'));
  });
  assert.deepEqual([...document.querySelectorAll('.transcript-artifact-frame')], frames);
  await act(async () => image.dispatchEvent(new window.Event('error')));
  assert.match(image.src, /\/original$/);
  await act(async () => {
    image.dispatchEvent(new window.Event('error'));
    poster.dispatchEvent(new window.Event('error'));
  });
  assert.deepEqual([...document.querySelectorAll('.transcript-artifact-frame')], frames);
  assert.equal(document.querySelector('.transcript-artifact-frame img'), null);
  assert.equal(document.querySelectorAll('.transcript-artifact-media figcaption').length, 2);
  // A failed thumbnail leaves the video playable from its dialog.
  assert.equal(frames[1].disabled, false);
  assert.equal(frames[0].disabled, true);
});

test('media cards keep the requested ratio until decoded and turn four or more into squares', async (t) => {
  const { root, document, window } = mount(t);
  window.mixdogDesktop.mediaUrl = (id, variant) => `https://mixdog.test/media/${id}/${variant}`;
  const generated = (id, aspect) => ({
    kind: 'tool',
    name: 'media',
    args: { action: 'generate', kind: 'image', aspect },
    result: { ok: true, status: 'done', kind: 'image', assetId: id },
  });
  const width = (figure) => figure.style.getPropertyValue('--artifact-width');
  await act(async () =>
    root.render(
      React.createElement(TranscriptArtifacts, { items: [generated('wide', '16:9'), generated('tall', '9:16')] })
    )
  );
  assert.ok(document.querySelector('.transcript-artifact-row'));
  const [wide, tall] = document.querySelectorAll('.transcript-artifact-media');
  assert.deepEqual([width(wide), wide.dataset.fit], ['284px', 'contain']);
  assert.deepEqual([width(tall), tall.dataset.fit], ['120px', 'top']);
  const items = ['a', 'b', 'c', 'd'].map((id) => generated(id, '16:9'));
  await act(async () => root.render(React.createElement(TranscriptArtifacts, { items })));
  assert.equal(document.querySelector('.transcript-artifact-row'), null);
  const cards = [...document.querySelectorAll('.transcript-artifact-grid > .transcript-artifact-media')];
  assert.equal(cards.length, 4);
  assert.ok(cards.every((card) => width(card) === '160px' && card.dataset.fit === 'cover'));
});

test('a restored visualize feedback message shows its pin lines and a pin-labelled crop placeholder', async (t) => {
  const { root, document } = mount(t);
  // What history restore yields for a message that carried a pin and a pick.
  const item = {
    kind: 'user',
    id: 'hist_s_3_1',
    text: [
      '핀과 선택 함께 전송',
      '📌 1 · input — 재로드 후에도 남는지 확인',
      '☑ layout: 2안 · 여유 있게',
      '[Image: visualize pin 1 · input, 177x21]',
    ].join('\n'),
  };
  await act(async () => root.render(React.createElement(TranscriptRow, { item })));
  const body = document.querySelector('.message-body').textContent;
  assert.match(body, /📌 1 · input — 재로드 후에도 남는지 확인/);
  assert.match(body, /☑ layout: 2안 · 여유 있게/);
  assert.doesNotMatch(body, /\[image|\[Image/i);
  assert.deepEqual(
    [...document.querySelectorAll('.message-attachments > .attachment-card')].map((chip) => chip.textContent),
    ['1 · input177×21']
  );
});

test('a tweaks line in a user message is drawn with an icon, not the emoji', async (t) => {
  const { root, document } = mount(t);
  const item = { kind: 'user', id: 'tweaks-message', text: 'Bake these\n🎚 card-radius: 24px (was 16px)' };
  await act(async () => root.render(React.createElement(TranscriptRow, { item })));
  const line = document.querySelector('.message-body .message-tweaks-line');
  assert.equal(line.textContent.trim(), 'card-radius: 24px (was 16px)');
  assert.ok(line.querySelector('svg'));
  assert.doesNotMatch(document.querySelector('.message-body').textContent, /🎚/);
  assert.equal(document.querySelector('.message-body > p').textContent, 'Bake these');
});

test("a group room's restored user row shows its files as a prompt row does", async (t) => {
  const { root, document } = mount(t);
  const image = 'a'.repeat(64);
  const item = {
    kind: 'user',
    id: 'sub-room',
    text: '[Image #1: shot.png] check [PDF #2: spec.pdf]',
    room: { kind: 'user' },
    images: [{ id: 1, name: 'shot.png', mimeType: 'image/png', bytes: 3, attachmentRef: image }],
  };
  await act(async () => root.render(React.createElement(TranscriptRow, { item })));
  assert.equal(document.querySelector('.message-body > p').textContent, 'check');
  const cards = [...document.querySelectorAll('.message-attachments > .attachment-card')];
  assert.equal(cards.length, 2);
  assert.equal(cards[0].textContent, 'shot.png');
  assert.match(cards[1].textContent, /spec\.pdf/);
});
test('inline image markers preserve user text and attachment chips', async (t) => {
  const { root, document } = mount(t);
  const item = {
    kind: 'user',
    id: 'image-message',
    text: 'Compare [Image #1]   with [Image #2: source] now.\n[Image: source: C:/work/a.png, 640x480]',
  };
  await act(async () => root.render(React.createElement(TranscriptRow, { item })));
  assert.equal(document.querySelector('.message-body > p').textContent, 'Compare with now.');
  assert.deepEqual(
    [...document.querySelectorAll('.message-attachments > .attachment-card')].map((chip) => chip.textContent),
    ['a.png640×480', 'Image']
  );

  await act(async () =>
    root.render(
      React.createElement(TranscriptRow, {
        item: { ...item, images: [{ id: 1, name: 'uploaded.png', bytes: 12 }] },
      })
    )
  );
  assert.equal(document.querySelector('.message-body > p').textContent, 'Compare with now.');
  assert.deepEqual(
    [...document.querySelectorAll('.message-attachments > .attachment-card')].map((chip) => chip.textContent),
    ['uploaded.png']
  );
});

test('intermediate turndone followed by a tool without attemptId stays suppressed while active and on cancellation, but never hides an already-idle end', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'u1', text: 'Work', checkpointId: 'cp1' };
  const reply1 = { kind: 'assistant', id: 'a1', text: 'Step 1.', attemptId: 'att1' };
  const end1 = {
    kind: 'turndone',
    id: 'd1',
    status: 'done',
    verb: 'Completed',
    elapsedMs: 1_000,
    attemptId: 'att1',
    checkpointId: 'cp1',
  };
  const toolNoAttempt = { kind: 'tool', id: 't1', name: 'shell', args: {}, result: 'ok' };
  const cancelledEnd = {
    kind: 'turndone',
    id: 'd2',
    status: 'cancelled',
    attemptId: 'att1',
    checkpointId: 'cp1',
  };
  let rows = [];
  let state = { pastLastEnd: false, trailingCheckpointShown: false };
  function Rows(props) {
    const out = useTranscriptRows({
      identity: props.identity ?? 'tool-cont',
      sessionKey: props.identity ?? 'tool-cont',
      settledItems: props.items,
      settledRowItems: props.items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy: props.busy,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    rows = out.transcriptRows;
    state = { pastLastEnd: out.pastLastEnd, trailingCheckpointShown: out.trailingCheckpointShown };
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Rows, props)));

  // Active turn watched while running emits an intermediate turndone and then a tool call without attemptId:
  // d1 is suppressed so no premature completion footer or card attaches to a1.
  await render({ items: [prompt, reply1], busy: true });
  await render({ items: [prompt, reply1, end1, toolNoAttempt], busy: true });
  const a1Row = rows.find((row) => row._tag === 'AssistantPart');
  assert.equal(a1Row?.completion, undefined, 'intermediate end is suppressed during tool continuation');
  assert.equal(a1Row?.turnChanges, undefined, 'no premature turn-changes card on a1');

  // If that turn is later cancelled with the same attemptId, d1 remains suppressed even when idle.
  await render({ items: [prompt, reply1, end1, toolNoAttempt, cancelledEnd], busy: false });
  const a1AfterCancel = rows.find((row) => row._tag === 'AssistantPart');
  assert.equal(a1AfterCancel?.completion, undefined, 'd1 stays suppressed after same-attempt cancelled turndone');

  // Contrast 1: if a turn actually stood idle at d1, a later promptless wake tool must NOT hide d1.
  await render({ identity: 'idle-wake', items: [prompt, reply1, end1], busy: false });
  assert.ok(rows.find((row) => row._tag === 'AssistantPart')?.completion, 'idle turn shows its completion');
  await render({ identity: 'idle-wake', items: [prompt, reply1, end1, toolNoAttempt], busy: true });
  assert.ok(
    rows.find((row) => row._tag === 'AssistantPart')?.completion,
    'already-idle turn keeps its completion when a later wake runs a tool'
  );
  assert.equal(state.pastLastEnd, true, 'idle-then-wake keeps pastLastEnd true so d1 card stays shown');

  // Contrast 2: mounting or switching back to a session during a promptless wake without an internal user item
  // (`[u1, a1, d1, toolNoAttempt]`, `busy: true`) must NOT suppress the already-settled d1 card while busy.
  await render({ identity: 'mount-wake', items: [prompt, reply1, end1, toolNoAttempt], busy: true });
  const mountedA1 = rows.find((row) => row._tag === 'AssistantPart');
  assert.ok(mountedA1?.completion, 'mounting mid-wake keeps settled d1 completion');
  assert.equal(mountedA1?.turnChanges?.checkpointId, 'cp1', 'mounting mid-wake keeps settled d1 card ref');
  assert.deepEqual(
    state,
    { pastLastEnd: true, trailingCheckpointShown: true },
    'mounting mid-wake marks pastLastEnd true so d1 card is not held while busy'
  );

  // Switching back through an empty hydrating frame before the snapshot arrives behaves identically.
  await render({ identity: 'switch-wake', items: [], busy: false });
  await render({ identity: 'switch-wake', items: [prompt, reply1, end1, toolNoAttempt], busy: true });
  const switchedA1 = rows.find((row) => row._tag === 'AssistantPart');
  assert.ok(switchedA1?.completion, 'switching back mid-wake keeps settled d1 completion');
  assert.equal(switchedA1?.turnChanges?.checkpointId, 'cp1', 'switching back mid-wake keeps settled d1 card ref');
  assert.deepEqual(
    state,
    { pastLastEnd: true, trailingCheckpointShown: true },
    'switching back mid-wake marks pastLastEnd true so d1 card is not held while busy'
  );
});

test('continuous hidden-wake loop keeps pastLastEnd and trailingCheckpointShown false until the session actually idles', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'u1', text: 'Run task', checkpointId: 'cp-1' };
  const a1 = { kind: 'assistant', id: 'a1', text: 'Spawning check.' };
  const d1 = { kind: 'turndone', id: 'd1', status: 'done', verb: 'Completed', checkpointId: 'cp-1' };
  const wake = { kind: 'user', id: 'u-wake', text: 'task done', internal: true };
  const t2 = { kind: 'tool', id: 't2', name: 'read', args: {}, result: 'ok' };
  const a2 = { kind: 'assistant', id: 'a2', text: 'All finished.' };
  const d2 = { kind: 'turndone', id: 'd2', status: 'done', verb: 'Completed', checkpointId: 'cp-1' };

  let state = { pastLastEnd: false, trailingCheckpointShown: false };
  function Rows(props) {
    const out = useTranscriptRows({
      identity: props.identity,
      sessionKey: props.identity,
      settledItems: props.items,
      settledRowItems: props.items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy: props.busy,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    state = { pastLastEnd: out.pastLastEnd, trailingCheckpointShown: out.trailingCheckpointShown };
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Rows, props)));

  // Continuous loop (never idle between d1 and wake -> d2):
  await render({ identity: 'loop-1', items: [prompt, a1, d1], busy: true });
  assert.deepEqual(state, { pastLastEnd: false, trailingCheckpointShown: false });

  await render({ identity: 'loop-1', items: [prompt, a1, d1, wake, t2], busy: true });
  assert.deepEqual(
    state,
    { pastLastEnd: false, trailingCheckpointShown: false },
    'hidden continuation keeps pastLastEnd false so trailing cards stay held'
  );

  await render({ identity: 'loop-1', items: [prompt, a1, d1, wake, t2, a2, d2], busy: true });
  assert.deepEqual(
    state,
    { pastLastEnd: false, trailingCheckpointShown: false },
    'reclosed d2 while still busy stays held because cp-1 never stood idle'
  );

  await render({ identity: 'loop-1', items: [prompt, a1, d1, wake, t2, a2, d2], busy: false });
  assert.deepEqual(state, { pastLastEnd: false, trailingCheckpointShown: true });

  // Contrast: if d1 DID stand idle before the wake started, its card stays visible through the wake.
  await render({ identity: 'loop-2', items: [prompt, a1, d1], busy: false });
  assert.deepEqual(state, { pastLastEnd: false, trailingCheckpointShown: true });

  await render({ identity: 'loop-2', items: [prompt, a1, d1, wake, t2], busy: true });
  assert.deepEqual(state, { pastLastEnd: true, trailingCheckpointShown: true });

  await render({ identity: 'loop-2', items: [prompt, a1, d1, wake, t2, a2, d2], busy: true });
  assert.deepEqual(state, { pastLastEnd: false, trailingCheckpointShown: true });
});

test('useTranscriptRows stays pure under StrictMode and preserves lifecycle across tab-switch remounts', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'u1', text: 'Run loop', checkpointId: 'cp-strict' };
  const a1 = { kind: 'assistant', id: 'a1', text: 'Step 1.' };
  const d1 = { kind: 'turndone', id: 'd1', status: 'done', verb: 'Completed', checkpointId: 'cp-strict', at: 1_000 };
  const toolNoAttempt = { kind: 'tool', id: 't2', name: 'shell', args: {}, result: 'ok' };

  let rows = [];
  let state = { turnPastEnd: false, pastLastEnd: false, trailingCheckpointShown: false };
  function Rows(props) {
    const out = useTranscriptRows({
      identity: props.identity,
      sessionKey: props.identity,
      settledItems: props.items,
      settledRowItems: props.items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: props.liveItem ?? null,
      busy: props.busy,
      commandBusy: false,
      commandActivityVisible: false,
      commandActivityStartedAt: props.commandActivityStartedAt ?? 0,
      optimisticActivityStartedAt: 0,
    });
    rows = out.transcriptRows;
    state = {
      turnPastEnd: out.turnPastEnd,
      pastLastEnd: out.pastLastEnd,
      trailingCheckpointShown: out.trailingCheckpointShown,
    };
    return null;
  }
  const render = (props) =>
    act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Rows, props))));

  // 1) Continuous loop survives StrictMode double-render AND unmount/remount through an empty hydrating frame.
  await render({ identity: 'strict-loop-remount', items: [prompt, a1, d1], busy: true });
  assert.deepEqual(state, { turnPastEnd: false, pastLastEnd: false, trailingCheckpointShown: false });

  await act(async () => root.render(null));
  await render({ identity: 'strict-loop-remount', items: [], busy: false });
  await render({ identity: 'strict-loop-remount', items: [prompt, a1, d1, toolNoAttempt], busy: true });
  assert.equal(
    rows.find((row) => row._tag === 'AssistantPart')?.completion,
    undefined,
    'remounting mid-loop still suppresses passed active end d1'
  );
  assert.equal(state.pastLastEnd, false);

  // 2) Idle-then-wake survives unmount/remount while busy at [prompt, a1, d1].
  await render({ identity: 'strict-wake-remount', items: [prompt, a1, d1], busy: false });
  assert.equal(state.trailingCheckpointShown, true);
  await act(async () => root.render(null));
  await render({ identity: 'strict-wake-remount', items: [prompt, a1, d1], busy: true });
  assert.equal(state.turnPastEnd, true, 'remounting during promptless wake remembers idleEnd');
  assert.equal(state.pastLastEnd, true);

  // 3) Activity timestamp strictly newer than active end d1 clears activeEnds before passedEnds runs on the same frame.
  await render({ identity: 'strict-timed-pass', items: [prompt, a1, d1], busy: true, commandActivityStartedAt: 900 });
  assert.equal(state.turnPastEnd, false);
  await render({
    identity: 'strict-timed-pass',
    items: [prompt, a1, d1, toolNoAttempt],
    busy: true,
    commandActivityStartedAt: 1_500,
  });
  assert.ok(
    rows.find((row) => row._tag === 'AssistantPart')?.completion,
    'newer activity clears activeEnds before passedEnds so settled d1 stays visible'
  );
  assert.equal(state.pastLastEnd, true);
});

test('releaseTranscriptRowLifecycle cleans up lifecycles keyed by draft-promoted identities', async (t) => {
  const { root } = mount(t);
  const prompt = { kind: 'user', id: 'u1', text: 'Draft prompt', checkpointId: 'cp-draft' };
  const a1 = { kind: 'assistant', id: 'a1', text: 'Done.' };
  const d1 = { kind: 'turndone', id: 'd1', status: 'done', verb: 'Completed', checkpointId: 'cp-draft', at: 1_000 };

  let state = { turnPastEnd: false, pastLastEnd: false, trailingCheckpointShown: false };
  function Rows(props) {
    const out = useTranscriptRows({
      identity: props.identity,
      sessionKey: props.sessionKey,
      settledItems: props.items,
      settledRowItems: props.items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy: props.busy,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    state = {
      turnPastEnd: out.turnPastEnd,
      pastLastEnd: out.pastLastEnd,
      trailingCheckpointShown: out.trailingCheckpointShown,
    };
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Rows, props)));

  // 1) Promoted draft whose namespace is tracked in transcript-virtual-cache.
  rememberTranscriptRowNamespace('sess-promoted-1', 'draft-release-1');
  await render({ identity: 'draft-release-1', sessionKey: 'sess-promoted-1', items: [prompt, a1, d1], busy: false });
  assert.equal(state.trailingCheckpointShown, true);
  await act(async () => root.render(null));

  releaseTranscriptRowLifecycle('sess-promoted-1');
  await render({ identity: 'draft-release-1', sessionKey: 'sess-promoted-1', items: [prompt, a1, d1], busy: true });
  assert.deepEqual(
    state,
    { turnPastEnd: false, pastLastEnd: false, trailingCheckpointShown: false },
    'releasing the promoted sessionId clears the draft-keyed lifecycle'
  );

  // 2) Even after >16 other promotions evict the virtual-cache namespace entry, release still clears the lifecycle.
  rememberTranscriptRowNamespace('sess-promoted-2', 'draft-release-2');
  await render({ identity: 'draft-release-2', sessionKey: 'sess-promoted-2', items: [prompt, a1, d1], busy: false });
  assert.equal(state.trailingCheckpointShown, true);
  for (let i = 0; i < 20; i += 1) {
    rememberTranscriptRowNamespace(`sess-evict-${i}`, `draft-evict-${i}`);
  }
  await act(async () => root.render(null));

  releaseTranscriptRowLifecycle('sess-promoted-2');
  await render({ identity: 'draft-release-2', sessionKey: 'sess-promoted-2', items: [prompt, a1, d1], busy: true });
  assert.deepEqual(
    state,
    { turnPastEnd: false, pastLastEnd: false, trailingCheckpointShown: false },
    'releasing by sessionId clears the mapped draft lifecycle even after virtual-cache namespace eviction'
  );
});

test('a standalone tool-ending completion settles the turn without a trailing Thinking row while busy', async (t) => {
  const { root } = mount(t);
  const items = [
    { kind: 'user', id: 'u1', text: 'Run edit', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'Editing now.' },
    { kind: 'tool', id: 't1', name: 'edit', args: {}, result: 'ok' },
    { kind: 'turndone', id: 'd1', status: 'complete', verb: 'Completed', checkpointId: 'cp-1', at: 1_000 },
  ];
  let rows = [];
  function Rows() {
    rows = useTranscriptRows({
      identity: 'tool-end-settled',
      sessionKey: 'tool-end-settled',
      settledItems: items,
      settledRowItems: items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy: true,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    }).transcriptRows;
    return null;
  }
  await act(async () => root.render(React.createElement(Rows)));
  assert.deepEqual(
    rows.map((row) => row._tag),
    ['UserMessage', 'AssistantPart', 'ToolActivity', 'AssistantPart'],
    'standalone tool-ending completion suppresses trailing Thinking while busy'
  );
  assert.equal(rows.at(-1)?.item?.id, 'd1');
});

test('a promptless wake after an idle tool-ending turn shows Thinking before new spinner or rows arrive', async (t) => {
  const { root } = mount(t);
  const items = [
    { kind: 'user', id: 'u1', text: 'Run edit', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'Editing now.' },
    { kind: 'tool', id: 't1', name: 'edit', args: {}, result: 'ok' },
    { kind: 'turndone', id: 'd1', status: 'complete', verb: 'Completed', checkpointId: 'cp-1', at: 1_000 },
  ];
  let out = { transcriptRows: [], turnPastEnd: false };
  function Rows({ busy }) {
    out = useTranscriptRows({
      identity: 'tool-end-wake',
      sessionKey: 'tool-end-wake',
      settledItems: items,
      settledRowItems: items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    return null;
  }

  // Prior tool-ending turn stands idle first.
  await act(async () => root.render(React.createElement(Rows, { busy: false })));
  assert.deepEqual(
    out.transcriptRows.map((row) => row._tag),
    ['UserMessage', 'AssistantPart', 'ToolActivity', 'AssistantPart']
  );

  // Promptless wake starts: busy flips true before spinner/tool/reply arrives.
  await act(async () => root.render(React.createElement(Rows, { busy: true })));
  assert.equal(out.turnPastEnd, true, 'wake is past the idle tool-ending completion');
  assert.deepEqual(
    out.transcriptRows.map((row) => row._tag),
    ['UserMessage', 'AssistantPart', 'ToolActivity', 'AssistantPart', 'TurnGap', 'Thinking'],
    'new promptless wake shows TurnGap and Thinking after prior standalone completion'
  );
});

test('per-session lifecycle metadata prunes prior turns so knownEnds and shownCheckpoints stay bounded', async (t) => {
  const { root } = mount(t);
  const identity = 'bounded-lifecycle';
  t.after(() => releaseTranscriptRowLifecycle(identity));

  function Rows({ items, busy }) {
    useTranscriptRows({
      identity,
      sessionKey: identity,
      settledItems: items,
      settledRowItems: items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem: null,
      busy,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    return null;
  }

  let items = [];
  for (let i = 1; i <= 30; i += 1) {
    const prompt = { kind: 'user', id: `u${i}`, text: `Turn ${i}`, checkpointId: `cp-${i}` };
    const reply = { kind: 'assistant', id: `a${i}`, text: `Reply ${i}` };
    const done = { kind: 'turndone', id: `d${i}`, status: 'complete', checkpointId: `cp-${i}` };
    items = [...items, prompt, reply, done];
    await act(async () => root.render(React.createElement(Rows, { items, busy: true })));
    await act(async () => root.render(React.createElement(Rows, { items, busy: false })));
  }
  const stats = _transcriptLifecycleStatsForTest(identity);
  assert.equal(stats.knownEnds, 1, 'knownEnds retains only the current turn window');
  assert.equal(stats.activeEnds, 0, 'activeEnds clears once idle');
  assert.equal(stats.shownCheckpoints, 1, 'shownCheckpoints retains only the current turn checkpoint');
});

test('status/footer slot stays continuous while the closing assistant row drains paced text at turn end', async (t) => {
  const { root, document } = mount(t);
  const { preloadSyncMarkdownParser } = await import('./markdown-worker-client');
  const { MarkdownSessionContext } = await import('./MarkdownLink');
  const { REVEAL_INTERVAL_MS } = await import('./use-transcript-text-reveal');
  const originalNow = performance.now.bind(performance);
  let clock = originalNow();
  performance.now = () => clock;
  t.after(() => {
    performance.now = originalNow;
    releaseTranscriptRowLifecycle('slot-continuity');
  });
  await preloadSyncMarkdownParser();

  const prompt = { kind: 'user', id: 'u1', text: 'Write a long answer' };
  const mid = `Hi ${'word '.repeat(50)}`;
  const full = `Hi ${'word '.repeat(100)}`;
  const done = { kind: 'turndone', id: 'd1', status: 'complete', elapsedMs: 2_000 };

  let currentRows = [];
  function Harness({ settledItems, liveItem, busy }) {
    const { transcriptRows } = useTranscriptRows({
      identity: 'slot-continuity',
      sessionKey: 'slot-continuity',
      settledItems,
      settledRowItems: settledItems,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      liveItem,
      busy,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    currentRows = transcriptRows;
    return React.createElement(
      MarkdownSessionContext.Provider,
      { value: 'slot-continuity' },
      transcriptRows.map((row) =>
        row._tag === 'AssistantPart'
          ? React.createElement(TranscriptRow, {
              key: row.key,
              item: row.item,
              completion: row.completion,
              revealKey: row.key,
              paced: true,
            })
          : row._tag === 'Thinking'
            ? React.createElement('div', { key: row.key, className: 'live-activity-slot', 'data-busy': 'true' })
            : null
      )
    );
  }

  // 1. Working with buffered backlog: Thinking slot is mounted, no completed footer yet.
  await act(async () =>
    root.render(
      React.createElement(Harness, {
        settledItems: [prompt],
        liveItem: { kind: 'assistant', id: 'a1', text: 'Hi ', streaming: true },
        busy: true,
      })
    )
  );
  await act(async () =>
    root.render(
      React.createElement(Harness, {
        settledItems: [prompt],
        liveItem: { kind: 'assistant', id: 'a1', text: mid, streaming: true },
        busy: true,
      })
    )
  );
  await act(async () =>
    root.render(
      React.createElement(Harness, {
        settledItems: [prompt],
        liveItem: { kind: 'assistant', id: 'a1', text: full, streaming: true },
        busy: true,
      })
    )
  );
  const thinkingKey = currentRows.find((row) => row._tag === 'Thinking')?.key;
  assert.ok(thinkingKey, 'Thinking band mounts while streaming');
  assert.ok(document.querySelector('.live-activity-slot[data-busy="true"]'));
  assert.equal(document.querySelector('.response-footer'), null);

  // 2. Turn settles while the closing assistant row is still draining paced text:
  //    Thinking slot stays mounted with the same key (no 40 -> 0 -> 40 px dip).
  clock += 80;
  await act(async () =>
    root.render(
      React.createElement(Harness, {
        settledItems: [prompt, { kind: 'assistant', id: 'a1', text: full, streaming: false }, done],
        liveItem: null,
        busy: false,
      })
    )
  );
  assert.equal(
    currentRows.find((row) => row._tag === 'Thinking')?.key,
    thinkingKey,
    'Thinking band keeps its slot and key while closing row drains paced text'
  );
  assert.ok(document.querySelector('.live-activity-slot[data-busy="true"]'));
  assert.equal(document.querySelector('.response-footer'), null);

  // 3. Drain completes: Thinking band drops and Completed footer mounts in the same flush.
  for (let i = 0; i < 30 && currentRows.some((row) => row._tag === 'Thinking'); i += 1) {
    clock += REVEAL_INTERVAL_MS;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }
  assert.equal(
    currentRows.some((row) => row._tag === 'Thinking'),
    false,
    'Thinking band leaves once drained'
  );
  assert.equal(document.querySelector('.live-activity-slot[data-busy="true"]'), null);
  assert.ok(document.querySelector('.response-footer'), 'Completed footer takes the slot immediately');
});
