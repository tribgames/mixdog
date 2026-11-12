// Replay of native/core/fixtures/slash-commands-cases (record-slash-commands-cases.mjs, b6f10295a). The slash command names,
// argument hints and the /btw panel scroll are the TUI's own (K1 keeps the TUI; the core only recognises slash tokens): each case's
// recorded inputs go through the TUI functions a user's keystrokes reach, and the whole observed value is compared, exactly encoded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exact } from '../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { normalizeSlashCommandName, overlayBlocksGlobalTranscriptScroll, slashArgumentHint } from './slash-commands.mjs';
import { BTW_CHROME_ROWS, btwContentRows, btwPanelRows, btwScrollMax, btwScrollOffset } from './btw-controller.mjs';

const golden = JSON.parse(readFileSync(new URL('../../../native/core/fixtures/slash-commands-cases/golden.json', import.meta.url), 'utf8'));
const recorded = (name) => {
  const found = golden.cases.find((entry) => entry.case === name);
  assert.ok(found, `no recorded case ${name}`);
  return found.observed;
};
const replay = (name, run) => test(name, () => assert.deepStrictEqual(exact(run()), recorded(name)));

replay('a command name resolves through its aliases, and an unknown one stays as typed', () => ({
  names: ['clear', 'NEW', 'Projects', 'nope', '', undefined].map((input) => ({ input, result: normalizeSlashCommandName(input) })),
}));
replay('an open /btw panel owns PageUp/PageDown and wheel scroll', () => ({
  overlays: [{ btwPanel: true }, {}].map((overlay) => ({ overlay, blocks: overlayBlocksGlobalTranscriptScroll(overlay) })),
}));
replay('btw scroll offsets page by one row less than the body, clamped to the content', () => {
  const long = { question: 'q', status: 'done', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n') };
  return {
    scrollMax: [[30, 10], [5, 10]].map(([content, body]) => ({ content, body, result: btwScrollMax(content, body) })),
    scrollOffset: [[{ pageDown: true }, 0, 10, 30], [{ pageDown: true }, 18, 10, 30], [{ pageUp: true }, 5, 10, 30], [{ pageUp: true }, 20, 10, 30], [{}, 50, 10, 30]].map((args) => ({ args, result: btwScrollOffset(...args) })),
    longAnswer: long, contentRows: btwContentRows(long, 80), panelRows: btwPanelRows(long, 80), chromeRows: BTW_CHROME_ROWS,
  };
});
replay('the argument hint comes from the resolved command, only after a trailing space', () => ({
  hints: ['/model ', '/autoclear ', '/projects ', '/clear ', '/nope ', '/model', '/model x ', ''].map((input) => ({ input, hint: slashArgumentHint(input) })),
}));
