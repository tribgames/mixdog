// A fling mounts and re-renders response footers on every range change, so
// their time text must not build a new locale formatter per footer.
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('response footers across many rows share one time formatter and keep the short time text', async () => {
  const { TranscriptResponseFooter } = await import('./transcript-row.tsx');
  const base = Date.UTC(2026, 0, 5, 9, 0);
  const items = Array.from({ length: 60 }, (_, index) => ({
    kind: 'assistant',
    id: `a${index}`,
    text: `reply ${index}`,
    at: base + index * 97_000,
  }));
  const expected = new Intl.DateTimeFormat('en', { timeStyle: 'short' });
  const RealFormat = Intl.DateTimeFormat;
  const realLocaleTime = Date.prototype.toLocaleTimeString;
  let formatters = 0;
  let localeTimes = 0;
  function CountingFormat(...args) {
    formatters++;
    return new RealFormat(...args);
  }
  CountingFormat.prototype = RealFormat.prototype;
  CountingFormat.supportedLocalesOf = RealFormat.supportedLocalesOf;
  Intl.DateTimeFormat = CountingFormat;
  Date.prototype.toLocaleTimeString = function toLocaleTimeString(...args) {
    localeTimes++;
    return realLocaleTime.apply(this, args);
  };
  let markup;
  try {
    markup = items.map((item) =>
      renderToStaticMarkup(React.createElement(TranscriptResponseFooter, { item, completion: item }))
    );
  } finally {
    Intl.DateTimeFormat = RealFormat;
    Date.prototype.toLocaleTimeString = realLocaleTime;
  }
  assert.ok(formatters + localeTimes <= 1, `formatters=${formatters} toLocaleTimeString=${localeTimes}`);
  items.forEach((item, index) => {
    assert.match(markup[index], new RegExp(`<time class="message-time">${expected.format(item.at)}</time>`));
  });
});
