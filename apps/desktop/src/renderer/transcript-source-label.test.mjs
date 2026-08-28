import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptRow, transcriptSourceLabel } from './transcript-row.tsx';

const markup = (item) => renderToStaticMarkup(React.createElement(TranscriptRow, { item }));

test('a direct user message carries no visible source badge', () => {
  for (const sender of ['user', 'USER', '', undefined]) {
    const item = { kind: 'user', id: 'u1', text: 'hello there', sender };
    assert.equal(transcriptSourceLabel(item), '');
    const html = markup(item);
    assert.ok(!html.includes('message-source'), `unexpected badge element for sender=${sender}`);
    assert.ok(!html.includes('USER'), `USER badge reappeared for sender=${sender}`);
    // The bubble itself must survive the badge removal.
    assert.ok(html.includes('class="message user'), 'user bubble class missing');
    assert.ok(html.includes('message-body'), 'message body missing');
    assert.ok(html.includes('hello there'), 'message text missing');
  }
});

test('a Lead-authored Agent brief keeps its visible LEAD badge', () => {
  const item = { kind: 'user', id: 'l1', text: 'Review this change.', sender: 'lead' };
  assert.equal(transcriptSourceLabel(item), 'LEAD');
  const html = markup(item);
  assert.ok(html.includes('<small class="message-source">LEAD</small>'), html);
  assert.ok(html.includes('sourced-message'), 'sourced-message class missing');
  assert.ok(html.includes('Review this change.'), 'message text missing');
});

test('assistant rows never take a source badge', () => {
  assert.equal(transcriptSourceLabel({ kind: 'assistant', id: 'a1', text: 'ok', sender: 'lead' }), '');
});
