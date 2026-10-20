import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, { expose: ['navigator', 'Node', 'Element', 'HTMLElement'] });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { default: React } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const {
  ComposerUsageReadout,
  cacheHitShare,
  formatCompactTokens,
  fittingVariant,
  liveTokensPerSecond,
  readoutVariants,
  usageReadoutParts,
  sessionUsageTotals,
  outputTokensPerSecond,
  totalTokens,
  usageReadoutText,
} = await import('./composer-usage-readout.tsx');

// Session-cumulative totals as the runtime persists them (the speed sums
// already hold only the calls with positive output and positive duration).
const totals = {
  input: 1200,
  cacheRead: 38000,
  cacheWrite: 2100,
  output: 800,
  speedOutputTokens: 720,
  speedMs: 15000,
};

test('tok/s is timed output over request time; cache hit is read over the whole prompt', () => {
  const usage = sessionUsageTotals({ usageReadout: totals });
  assert.equal(outputTokensPerSecond(usage), 48);
  assert.equal(cacheHitShare(usage), 38000 / (1200 + 38000 + 2100));
  assert.equal(usageReadoutText(usage), '42.1k 48/s 92.0%');
  // Nothing timed: the others stand without it; no cache read: no cache part.
  assert.equal(usageReadoutText({ ...usage, speedMs: 0, speedOutputTokens: 0 }), '42.1k 92.0%');
  assert.equal(usageReadoutText({ ...usage, cacheRead: 0 }), '4.1k 48/s');
  assert.equal(usageReadoutText(sessionUsageTotals({})), null);
  assert.equal(outputTokensPerSecond(null), null);
  assert.equal(cacheHitShare(null), null);
});

test('tok/s is the request-time rate (first-token wait included); a record without it falls back to the older speed', () => {
  const base = { input: 1200, cacheRead: 38000, cacheWrite: 2100, output: 800 };
  // Saved before the request-time sums: the first-token speed still reads.
  assert.equal(
    outputTokensPerSecond(sessionUsageTotals({ usageReadout: { ...base, speedOutputTokens: 720, speedMs: 4000 } })),
    180
  );
  // Request-time sums take over, ignoring the older pair: 720 tokens over 8 s.
  const both = {
    ...base,
    speedOutputTokens: 720,
    speedMs: 4000,
    requestOutputTokens: 720,
    requestMs: 8000,
  };
  assert.equal(outputTokensPerSecond(sessionUsageTotals({ usageReadout: both })), 90);
  assert.equal(
    outputTokensPerSecond(sessionUsageTotals({ usageReadout: { ...base, requestOutputTokens: 500, requestMs: 5000 } })),
    100
  );
});

test('total tokens sum input, cache read, cache write and output; compact like 12.3k / 1.2M', () => {
  assert.equal(totalTokens(sessionUsageTotals({ usageReadout: totals })), 42100);
  assert.equal(totalTokens(null), null);
  assert.equal(totalTokens(sessionUsageTotals({ usageReadout: { input: 0, output: 0 } })), null);
  // A record saved before the output sum existed shows no total, not a short one.
  const legacy = sessionUsageTotals({ usageReadout: { ...totals, output: undefined } });
  assert.equal(totalTokens(legacy), null);
  assert.equal(usageReadoutText(legacy), '48/s 92.0%');
  const cases = [
    [0, '0'],
    [842, '842'],
    [999, '999'],
    [1000, '1k'],
    [12_345, '12.3k'],
    [999_949, '999.9k'],
    [999_950, '1M'],
    [1_200_000, '1.2M'],
    [1_234_567_890, '1.2B'],
  ];
  for (const [value, text] of cases) assert.equal(formatCompactTokens(value), text, String(value));
  assert.equal(
    usageReadoutText(sessionUsageTotals({ usageReadout: { input: 700_000, cacheRead: 400_000, output: 100_000 } })),
    '1.2M 36.4%'
  );
});

test('the cache part stays hidden until the session has read from the cache', () => {
  const cold = sessionUsageTotals({ usageReadout: { ...totals, cacheRead: 0 } });
  assert.equal(cacheHitShare(cold), null);
  assert.equal(usageReadoutText(cold), '4.1k 48/s');
  assert.equal(
    usageReadoutText(sessionUsageTotals({ usageReadout: { input: 500, cacheWrite: 900 } })),
    null,
    'no output sum, no cache read, no timed call: nothing to say'
  );
});

test('the figures are the session sums, not a mean of per-turn rates', () => {
  // Two turns: 200 tokens in 4 s (50 tok/s) and 100 tokens in 4 s (25 tok/s)
  // read as 300 / 8 s, and a 50% then a 100% cache turn as 3000 / 4000.
  const sum = sessionUsageTotals({
    usageReadout: { input: 1000, cacheRead: 3000, cacheWrite: 0, output: 300, speedOutputTokens: 300, speedMs: 8000 },
  });
  assert.equal(outputTokensPerSecond(sum), 37.5);
  assert.equal(cacheHitShare(sum), 0.75);
  assert.equal(usageReadoutText(sum), '4.3k 38/s 75.0%');
});

test('the streaming call shows its own live rate, past the floors, in place of the session speed', () => {
  const live = (outputTokens, at, startedAt = 10_000) => ({ active: true, liveCall: { startedAt, outputTokens, at } });
  // 300 estimated tokens over 4 s since its request started.
  assert.equal(liveTokensPerSecond(live(300, 14_000)), 75);
  // Not before 50 estimated tokens and 1.5 s of streaming.
  assert.equal(liveTokensPerSecond(live(49, 20_000)), null);
  assert.equal(liveTokensPerSecond(live(200, 11_499)), null);
  assert.equal(liveTokensPerSecond(live(60, 11_500)), 40);
  // Between calls there is no live call (or no active spinner).
  assert.equal(liveTokensPerSecond({ active: true }), null);
  assert.equal(liveTokensPerSecond({ active: true, liveCall: null }), null);
  assert.equal(liveTokensPerSecond({ ...live(300, 14_000), active: false }), null);
  assert.equal(liveTokensPerSecond(null), null);

  const usage = sessionUsageTotals({ usageReadout: totals });
  assert.equal(usageReadoutText(usage, 75), '42.1k ~75/s 92.0%');
  // The live rate stands even before the session has any timed call.
  assert.equal(usageReadoutText(null, 75), '~75/s');
  // Each new sample re-renders: the figure follows the call's latest sample.
  const render = (spinner) =>
    renderToStaticMarkup(
      React.createElement(ComposerUsageReadout, {
        snapshot: { sessionId: 's1', stats: { usageReadout: totals }, spinner },
        onOpenUsage() {},
      })
    );
  const sep = '<span class="composer-readout-sep" aria-hidden="true">·</span>';
  assert.match(
    render(live(300, 14_000)),
    new RegExp(`42\\.1k tokens${sep}</span>.*~75 tok/s${sep}</span>.*Cache hit 92\\.0%</span>`)
  );
  assert.match(render(live(500, 15_000)), new RegExp(`~100 tok/s${sep}</span>`));
  // When the call ends the spinner drops its live call and the session figure returns.
  assert.match(render({ active: true, liveCall: null }), new RegExp(`>48 tok/s${sep}</span>`));
});

test('the readout hides until the session reported usage, then is one button with no hover card', () => {
  const render = (stats) =>
    renderToStaticMarkup(
      React.createElement(ComposerUsageReadout, { snapshot: { sessionId: 's1', stats }, onOpenUsage() {} })
    );
  assert.equal(render(undefined), '');
  assert.equal(render({ inputTokens: 10 }), '');
  // A session saved before the totals existed shows nothing, not a guess.
  assert.equal(render({ inputTokens: 10, promptTokens: 641000, cachedTokens: 610000 }), '');
  const html = render({
    usageReadout: totals,
    promptTokens: 641000,
    cachedTokens: 610000,
    cacheWriteTokens: 13000,
    outputTokens: 12000,
  });
  assert.match(
    html,
    /^<button type="button" class="composer-usage-readout"[^>]*>(<span class="composer-readout-item"[^>]*>.*<\/span>){3}<\/button>$/
  );
});

test('a narrowing line drops cache hit first, then the token total, tok/s last', () => {
  const parts = usageReadoutParts(sessionUsageTotals({ usageReadout: totals }));
  const variants = readoutVariants(parts);
  const texts = (list) =>
    list.map((items) => items.map((item) => (item.separator ? `${item.text} ·` : item.text)).join(' '));
  // Worded first (room to spare), then the icon form, then fewer parts.
  assert.deepEqual(texts(variants), [
    '42.1k tokens · 48 tok/s · Cache hit 92.0%',
    '42.1k 48/s 92.0%',
    '42.1k 48/s',
    '48/s',
  ]);
  assert.deepEqual(
    variants.map((items) => items.some((item) => item.icon)),
    [false, true, true, true]
  );
  assert.equal(usageReadoutText(sessionUsageTotals({ usageReadout: totals }), null, 2), '42.1k 48/s');
  // With no speed yet, the total outlasts the cache hit.
  const noSpeed = usageReadoutParts(sessionUsageTotals({ usageReadout: { ...totals, speedMs: 0 } }));
  assert.deepEqual(texts(readoutVariants(noSpeed)), ['42.1k tokens · Cache hit 92.0%', '42.1k 92.0%', '42.1k']);
  assert.deepEqual(readoutVariants(usageReadoutParts(null)), []);
  // The fullest variant that fits; none fits: the readout hides.
  assert.equal(fittingVariant([300, 200, 80], 400), 0);
  assert.equal(fittingVariant([300, 200, 80], 250), 1);
  assert.equal(fittingVariant([300, 200, 80], 80), 2);
  assert.equal(fittingVariant([300, 200, 80], 79), -1);
});

test('each coding item carries its full words as tooltip and accessible name', () => {
  const parts = usageReadoutParts(sessionUsageTotals({ usageReadout: totals }), 75);
  assert.equal(parts.total.label, 'Total tokens 42.1k');
  assert.equal(parts.speed.label, 'Output speed ~75 tok/s');
  assert.equal(parts.hit.label, 'Cache hit 92.0%');
  const html = renderToStaticMarkup(
    React.createElement(ComposerUsageReadout, {
      snapshot: { sessionId: 's1', stats: { usageReadout: totals } },
      onOpenUsage() {},
    })
  );
  assert.match(html, /title="Total tokens 42\.1k" aria-label="Total tokens 42\.1k"/);
  // Room to spare: the worded form, no icons; the icon form is the next variant.
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /42\.1k tokens<span class="composer-readout-sep" aria-hidden="true">·<\/span>/);
  assert.ok(readoutVariants(parts)[1].every((item) => item.icon));
});
