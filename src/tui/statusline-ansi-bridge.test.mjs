import test from 'node:test';
import assert from 'node:assert/strict';
import {
  remapCanonicalStatuslineTruecolor,
  normalizeStatuslineAnsi,
  statuslineFooterCacheKey,
  statuslineFooterIdentityChanged,
  isResetStatsState,
  STATUSLINE_CANONICAL_TRUECOLOR,
} from './statusline-ansi-bridge.mjs';
import { theme, setThemeSetting } from './theme.mjs';

function sgr38(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function statusColorsFromTheme() {
  const ansiRgb = (value, fallback) => {
    const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(value || '').replace(/\s+/g, ''));
    if (!match) return fallback;
    return sgr38(match[1], match[2], match[3]);
  };
  return {
    STATUS: ansiRgb(theme.statusText, sgr38(198, 198, 198)),
    SUBTLE: ansiRgb(theme.statusSubtle, sgr38(136, 136, 136)),
    SUCCESS: ansiRgb(theme.success, sgr38(0, 170, 75)),
    WARNING: ansiRgb(theme.warning, sgr38(255, 193, 7)),
    ERROR: ansiRgb(theme.error, sgr38(220, 70, 88)),
  };
}

test('remaps canonical truecolor sequences from ui/statusline.mjs', () => {
  const colors = statusColorsFromTheme();
  const subtle = sgr38(...STATUSLINE_CANONICAL_TRUECOLOR.subtle);
  const success = sgr38(...STATUSLINE_CANONICAL_TRUECOLOR.success);
  const raw = `${subtle}│\x1b[0m ${success}42%`;
  const out = remapCanonicalStatuslineTruecolor(raw, colors);
  assert.ok(!out.includes('38;2;136;136;136'), 'subtle canonical RGB should be replaced');
  assert.ok(!out.includes('38;2;0;170;75'), 'success canonical RGB should be replaced');
  assert.ok(out.includes(colors.SUBTLE));
  assert.ok(out.includes(colors.SUCCESS));
});

test('normalizeStatuslineAnsi maps bold and legacy SGR plus truecolor', () => {
  const colors = statusColorsFromTheme();
  const raw = `\x1b[1mmodel\x1b[0m \x1b[33m5H\x1b[0m ${sgr38(...STATUSLINE_CANONICAL_TRUECOLOR.error)}quota`;
  const out = normalizeStatuslineAnsi(raw, colors);
  assert.ok(out.includes(colors.STATUS));
  assert.ok(out.includes(colors.WARNING));
  assert.ok(out.includes(colors.ERROR));
  assert.ok(!out.includes('\x1b[33m'));
  assert.ok(!out.includes('38;2;220;70;88'));
});

test('normalizeStatuslineAnsi preserves leading diamond glyph', () => {
  const colors = statusColorsFromTheme();
  const subtle = sgr38(...STATUSLINE_CANONICAL_TRUECOLOR.subtle);
  const raw = `${subtle}◆\x1b[0m \x1b[1mgpt-4o\x1b[0m`;
  const out = normalizeStatuslineAnsi(raw, colors);
  assert.ok(out.includes('◆'), 'visible ◆ must remain');
  assert.ok(out.includes('gpt-4o'));
  assert.ok(out.indexOf('◆') < out.indexOf('gpt-4o'));
});

test('retimes bare values after reset without clobbering explicit segment colors', () => {
  const colors = statusColorsFromTheme();
  const subtle = colors.SUBTLE;
  const success = colors.SUCCESS;
  const warning = colors.WARNING;
  const reset = '\x1b[0m';
  const creditSeg = `${subtle}Credit${reset} $12.34`;
  const outCredit = normalizeStatuslineAnsi(creditSeg, colors, { reset });
  assert.ok(outCredit.includes('$12.34'));
  const moneyIdx = outCredit.indexOf('$12.34');
  assert.ok(moneyIdx > 0);
  assert.ok(outCredit.slice(0, moneyIdx).includes(colors.STATUS), 'bare credit amount uses status text');

  const usedLimit = `${subtle}5H${reset} $3.00/$10.00`;
  const outUsed = normalizeStatuslineAnsi(usedLimit, colors, { reset });
  assert.ok(outUsed.includes('$3.00/$10.00'));
  assert.ok(outUsed.slice(0, outUsed.indexOf('$3.00')).includes(colors.STATUS));

  const colored = `${subtle}5H${reset} ${warning}est $5.00${reset}`;
  const outColored = normalizeStatuslineAnsi(colored, colors, { reset });
  assert.ok(outColored.includes(warning), 'warning color on value must remain');
  const estIdx = outColored.indexOf('est');
  assert.ok(estIdx > 0);
  assert.ok(outColored.slice(0, estIdx).includes(warning));
});

test('statuslineFooterCacheKey changes when session or route identity changes', () => {
  const a = statuslineFooterCacheKey({ sessionId: 's1', provider: 'p', model: 'm1' });
  const b = statuslineFooterCacheKey({ sessionId: 's2', provider: 'p', model: 'm1' });
  const c = statuslineFooterCacheKey({ sessionId: 's1', provider: 'p', model: 'm2' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('statusline footer identity tracks context display boundary fields', () => {
  const base = {
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    contextWindow: 1_000_000,
    displayContextWindow: 900_000,
    rawContextWindow: 1_000_000,
    compactBoundaryTokens: 900_000,
    autoCompactTokenLimit: 810_000,
    stats: { currentEstimatedContextTokens: 10_000 },
  };
  const changedDisplay = { ...base, displayContextWindow: 800_000 };
  const changedBoundary = { ...base, compactBoundaryTokens: 800_000 };
  const changedTrigger = { ...base, autoCompactTokenLimit: 720_000 };

  assert.notEqual(statuslineFooterCacheKey(base), statuslineFooterCacheKey(changedDisplay));
  assert.notEqual(statuslineFooterCacheKey(base), statuslineFooterCacheKey(changedBoundary));
  assert.notEqual(statuslineFooterCacheKey(base), statuslineFooterCacheKey(changedTrigger));
  assert.equal(statuslineFooterIdentityChanged(changedDisplay, base), true);
  assert.equal(statuslineFooterIdentityChanged(changedBoundary, base), true);
  assert.equal(statuslineFooterIdentityChanged(changedTrigger, base), true);
});

test('stats reset transition is footer identity change (cache must not reuse on /theme)', () => {
  const activeStats = {
    currentContextTokens: 1200,
    inputTokens: 800,
    turns: 2,
  };
  const resetStats = {
    currentContextTokens: 0,
    currentEstimatedContextTokens: 0,
    inputTokens: 0,
    latestInputTokens: 0,
    promptTokens: 0,
    turns: 0,
  };
  assert.equal(isResetStatsState(resetStats), true);
  assert.equal(isResetStatsState(activeStats), false);
  const sameRoute = { sessionId: 's1', provider: 'p', model: 'm', stats: resetStats };
  const lastRoute = { sessionId: 's1', provider: 'p', model: 'm', stats: activeStats };
  assert.equal(statuslineFooterCacheKey(sameRoute), statuslineFooterCacheKey(lastRoute));
  assert.equal(statuslineFooterIdentityChanged(sameRoute, lastRoute), true);
});

test('theme switch changes normalized output when raw line is canonical', () => {
  setThemeSetting('mixdog', { persist: false });
  const colorsA = statusColorsFromTheme();
  const raw = `${sgr38(...STATUSLINE_CANONICAL_TRUECOLOR.success)}▓▓\x1b[0m ${sgr38(...STATUSLINE_CANONICAL_TRUECOLOR.subtle)}░░`;
  const tonedA = normalizeStatuslineAnsi(raw, colorsA);

  setThemeSetting('pi-dark', { persist: false });
  const colorsB = statusColorsFromTheme();
  const tonedB = normalizeStatuslineAnsi(raw, colorsB);

  assert.notEqual(tonedA, tonedB);
  assert.ok(tonedB.includes(colorsB.SUCCESS));
  assert.ok(tonedB.includes(colorsB.SUBTLE));
  setThemeSetting('mixdog', { persist: false });
});
