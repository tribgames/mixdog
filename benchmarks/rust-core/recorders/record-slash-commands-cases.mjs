#!/usr/bin/env node
// Recording of tui/app/slash-commands.test.mjs (b6f10295a), the two cases whose behaviour stays in the product: the slash command
// registry's alias resolution (normalizeSlashCommandName) and the argument hint of the resolved command (slashArgumentHint). The two
// /btw panel cases (overlayBlocksGlobalTranscriptScroll, btwScroll*) are Node-TUI-only and are not recorded.
//
//   node benchmarks/rust-core/recorders/record-slash-commands-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('slash-commands-cases', import.meta.url);
const { normalizeSlashCommandName, overlayBlocksGlobalTranscriptScroll, slashArgumentHint } = await set.load('src/tui/app/slash-commands.mjs');
const { BTW_CHROME_ROWS, btwContentRows, btwPanelRows, btwScrollMax, btwScrollOffset } = await set.load('src/tui/app/btw-controller.mjs');

await set.run('a command name resolves through its aliases, and an unknown one stays as typed', () => ({
  names: ['clear', 'NEW', 'Projects', 'nope', '', undefined].map((input) => ({ input, result: normalizeSlashCommandName(input) })),
}));
await set.run('an open /btw panel owns PageUp/PageDown and wheel scroll', () => ({
  overlays: [{ btwPanel: true }, {}].map((overlay) => ({ overlay, blocks: overlayBlocksGlobalTranscriptScroll(overlay) })),
}));
await set.run('btw scroll offsets page by one row less than the body, clamped to the content', () => {
  const long = { question: 'q', status: 'done', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n') };
  return {
    scrollMax: [[30, 10], [5, 10]].map(([content, body]) => ({ content, body, result: btwScrollMax(content, body) })),
    scrollOffset: [[{ pageDown: true }, 0, 10, 30], [{ pageDown: true }, 18, 10, 30], [{ pageUp: true }, 5, 10, 30], [{ pageUp: true }, 20, 10, 30], [{}, 50, 10, 30]].map((args) => ({ args, result: btwScrollOffset(...args) })),
    longAnswer: long, contentRows: btwContentRows(long, 80), panelRows: btwPanelRows(long, 80), chromeRows: BTW_CHROME_ROWS,
  };
});
await set.run('the argument hint comes from the resolved command, only after a trailing space', () => ({
  hints: ['/model ', '/autoclear ', '/projects ', '/clear ', '/nope ', '/model', '/model x ', ''].map((input) => ({ input, hint: slashArgumentHint(input) })),
}));

await set.finish({
  entry: { runs: 'src/tui/app/slash-commands.mjs normalizeSlashCommandName and slashArgumentHint over the real command registry', notRun: 'the Node TUI is not rendered: the /btw panel cases record its pure scroll and row functions (overlayBlocksGlobalTranscriptScroll, btwScrollMax/Offset, btwContentRows/PanelRows) as a client observes them' },
  replay: {
    entry: 'NO RUST ENTRY ON o1: these behaviours stay in the client (the Node TUI, src/tui/app); the core serves only recognised_slash_token (pending.rs), read from its own registry',
    replayedBy: 'src/tui/app/slash-commands-replay.test.mjs: every case through the K1 TUI (src/tui/app/slash-commands.mjs normalizeSlashCommandName, slashArgumentHint, overlayBlocksGlobalTranscriptScroll; src/tui/app/btw-controller.mjs btwScrollMax/Offset, btwContentRows/PanelRows), the whole observed value exact-encoded.',
    normalised: {},
  },
  exclusions: {
    aliasNormalising: 'normalizeSlashCommandName: no Rust replay; the TUI resolves a typed name before it submits, the core never receives an alias. Owner that keeps it: src/tui/app/slash-commands.mjs',
    argumentHint: 'slashArgumentHint: the prompt line draws it while the user types (use-prompt-draft-flow/draft-change.mjs); no request carries it. Owner that keeps it: src/tui/app/slash-commands.mjs',
    btwScroll: 'overlayBlocksGlobalTranscriptScroll, btwScrollMax/Offset, btwContentRows/PanelRows: key handling and row counts of the TUI panel (use-global-key-input.mjs). Owner that keeps it: src/tui/app/btw-controller.mjs',
  },
});
process.exit(0);
