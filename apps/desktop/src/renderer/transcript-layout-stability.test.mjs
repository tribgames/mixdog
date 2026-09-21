import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { TranscriptAssistantRow } from './TranscriptAssistantRow';
import { TranscriptRow } from './transcript-row';
import { ComposerDock } from './ComposerDock';
import { TranscriptArtifacts } from './transcript-artifacts-ui';
import { rememberAgentReviews } from './turn-review-cache';
import { turnReviewScope } from './renderer-logic.mjs';
import { preloadMarkdownBody } from './markdown-body-loader';
import { parseStreamingMarkdownAst } from './markdown-worker-client';

function mount(t) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const names = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const overrides = { window: dom.window, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: overrides[name] ?? dom.window[name],
    });
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.mixdogDesktop = {};
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
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

test('completion reserves the review slot through stale and queued final responses, including an empty final diff', async (t) => {
  const { root, document, window } = mount(t);
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
      goalSubmissionId: '',
      showProjectSelector: false,
      softCollapseContextBar: { current: false },
      reviewStreamingTail: null,
      reviewActive: true,
      reviewSessionId: sessionId,
      reviewCwd: 'C:/work',
      children: React.createElement('textarea'),
    };
    const render = (busy, reviewItems) =>
      act(async () =>
        root.render(
          React.createElement(ComposerDock, { ...props, reviewItems, reviewTurnLive: busy, reviewBusy: busy })
        )
      );
    const slot = () => document.querySelector('.turn-review-slot');
    await render(true, items);
    assert.equal(pending.length, 1);
    assert.equal(slot().dataset.reserved, 'true');
    await render(false, [...items, { kind: 'turndone', id: 'done', status: 'complete' }]);
    assert.equal(slot().dataset.reserved, 'true', 'completion must not release an unanswered boundary');
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
    assert.equal(slot().dataset.reserved, 'true', 'an older response must not release the queued final read');
    await act(async () =>
      pending.shift()(response(hasDiff ? [{ path: 'demo.ts', status: 'M', additions: 1, deletions: 1 }] : []))
    );
    assert.equal(slot().dataset.reserved, 'false');
    assert.equal(Boolean(document.querySelector('.turn-review-bar')), hasDiff);
    assert.equal(pending.length, 0);
    await act(async () => root.render(null));
  }
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
  const image = document.querySelector('.transcript-artifact-image img');
  const video = document.querySelector('video');
  await act(async () => {
    image.dispatchEvent(new window.Event('load'));
    video.dispatchEvent(new window.Event('loadedmetadata'));
  });
  assert.deepEqual([...document.querySelectorAll('.transcript-artifact-frame')], frames);
  await act(async () => image.dispatchEvent(new window.Event('error')));
  assert.match(image.src, /\/original$/);
  await act(async () => {
    image.dispatchEvent(new window.Event('error'));
    video.dispatchEvent(new window.Event('error'));
  });
  assert.deepEqual([...document.querySelectorAll('.transcript-artifact-frame')], frames);
  assert.equal(document.querySelector('.transcript-artifact-image img, video'), null);
  assert.equal(document.querySelectorAll('.transcript-artifact-media figcaption').length, 2);
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
    [...document.querySelectorAll('.message-image-chip')].map((chip) => chip.textContent),
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
    [...document.querySelectorAll('.message-image-chip')].map((chip) => chip.textContent),
    ['uploaded.png']
  );
});
