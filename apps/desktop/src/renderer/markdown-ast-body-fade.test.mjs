import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { parseMarkdownToHast } from './markdown-ast';
import { STREAM_FADE_DURATION_MS, StreamFadeTimeline } from './markdown-stream-fade';
import MarkdownAstBody from './MarkdownAstBody';

test('a body whose fade-end timer wakes before the clock reads the end is unwrapped once the end is reached', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const text = 'Hi there';
  const timeline = new StreamFadeTimeline(clock);
  timeline.commit(timeline.read(text, clock));
  const wrappers = () => document.querySelectorAll('[data-stream-fade]').length;
  await act(async () =>
    root.render(
      React.createElement(MarkdownAstBody, {
        root: parseMarkdownToHast(text),
        copyControl: () => null,
        fadeTimeline: timeline,
      })
    )
  );
  assert.equal(wrappers(), 1, 'its words fade in');
  // The timer set for the fade's end runs while the clock still reads just short of it (setTimeout drops the fraction
  // of its delay; Chromium may run a long timer early).
  clock += STREAM_FADE_DURATION_MS - 0.5;
  await act(async () => t.mock.timers.tick(STREAM_FADE_DURATION_MS));
  // The end is reached, and passed: nothing else renders the body.
  clock += STREAM_FADE_DURATION_MS;
  await act(async () => t.mock.timers.tick(STREAM_FADE_DURATION_MS));
  assert.equal(document.querySelector('p')?.textContent, text);
  assert.equal(wrappers(), 0, 'no wrapper outlives its fade');
});
