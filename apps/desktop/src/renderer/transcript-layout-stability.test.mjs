import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TranscriptAssistantRow } from './TranscriptAssistantRow';
import { TranscriptRow } from './transcript-row';
import { ComposerDock } from './ComposerDock';
import { TranscriptArtifacts } from './transcript-artifacts-ui';
import { rememberAgentReviews } from './turn-review-cache';
import { turnReviewScope } from './renderer-logic.mjs';
import { preloadMarkdownBody } from './markdown-body-loader';
import { parseStreamingMarkdownAst } from './markdown-worker-client';

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
  assert.equal(document.querySelector('[data-transcript-pending]'), null);
  assert.ok(document.querySelector('.response-footer'));
});

test('the island files segment appears only once the review read finds changes, including an empty final diff', async (t) => {
  const { root, document, window } = mount(t);
  // ComposerDock loads the review module lazily; with the chunk cached it
  // mounts in the first commit.
  await import('./TurnReview');
  for (const hasDiff of [true, false]) {
    const pending = [];
    window.mixdogDesktop.invokeCapability = (request) => {
      assert.equal(request.capability, 'getTurnReviewDiff');
      return new Promise((resolve) => pending.push(resolve));
    };
    const sessionId = `review-completion-${hasDiff}`;
    const items = [
      { kind: 'user', id: 'prompt', text: 'Change a file' },
      { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated demo.ts' },
    ];
    const scope = turnReviewScope(items).key;
    rememberAgentReviews(`${sessionId}:${scope}`, [], '', [], 'worktree', scope);
    const props = {
      sessionId: '',
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
    await act(async () => pending.shift()(response([])));
    assert.equal(pending.length, 1);
    assert.equal(segment(), null, 'an empty response renders nothing');
    await act(async () =>
      pending.shift()(response(hasDiff ? [{ path: 'demo.ts', status: 'M', additions: 1, deletions: 1 }] : []))
    );
    assert.equal(document.querySelector('.turn-review-bar'), null, 'the review bar left the composer stack');
    assert.equal(Boolean(segment()), hasDiff);
    if (hasDiff) assert.equal(segment().closest('.composer-island-pill')?.parentElement?.className, 'composer-island');
    assert.ok(slot);
    assert.equal(islandSlot(), slot, 'the island slot stays mounted whatever it shows');
    assert.equal(pending.length, 0);
    if (hasDiff) {
      assert.match(segment().textContent, /\+1 −1$/, 'a space separates the line counts');
      assert.match(segment().textContent, /^1 file\+1/, 'the count in words, singular for one file');
      assert.ok(segment().firstElementChild.classList.contains('composer-island-seg-icon'), 'the file glyph leads');
      assert.equal(segment().querySelector('.composer-island-seg-num').dataset.count, '1');
      // No side dock here (no onOpenSessionDiff): the segment expands the
      // island to the turn's file list in place, and Escape collapses it.
      await act(async () => segment().click());
      assert.equal(document.querySelector('.composer-island').dataset.expanded, 'files');
      const bar = document.querySelector('.composer-island-pill > .turn-review-bar');
      assert.equal(bar?.dataset.expanded, 'true');
      assert.match(bar.querySelector('.turn-review-files').textContent, /demo\.ts/);
      await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
      assert.equal(document.querySelector('.composer-island').dataset.expanded, undefined);
      assert.ok(segment(), 'collapsing returns to the segment');
    }
    await act(async () => root.render(null));
  }
});

test('a transcript tail without its prompt row keeps the turn review of that turn', async (t) => {
  const { root, document, window } = mount(t);
  await import('./TurnReview');
  const pending = [];
  window.mixdogDesktop.invokeCapability = () => new Promise((resolve) => pending.push(resolve));
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
            sessionId: '',
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
  // The segment names counts, not paths: this turn's demo.ts is +1, the
  // unrelated stale review is +900.
  const segmentText = () => document.querySelector('.turn-review-segment')?.textContent || '';
  await render([{ kind: 'user', id: 'prompt', text: 'Change a file' }, edit('edit-1')]);
  await answer('prompt', 'demo.ts');
  assert.match(segmentText(), /\+1(?!\d)/);
  // The daemon re-cut its tail: the prompt row is gone, the turn goes on.
  await render([edit('edit-1'), edit('edit-2')]);
  assert.match(segmentText(), /\+1(?!\d)/);
  assert.doesNotMatch(segmentText(), /900/);
  // A previous turn's recorded review still fails the checkpoint check.
  await answer('old', 'stale.ts', 900);
  assert.match(segmentText(), /\+1(?!\d)/);
  assert.doesNotMatch(segmentText(), /900/);
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
