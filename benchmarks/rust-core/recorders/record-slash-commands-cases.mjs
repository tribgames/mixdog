#!/usr/bin/env node
// Recording of tui/app/slash-commands.test.mjs (b6f10295a): the slash command registry's alias resolution (normalizeSlashCommandName),
// the argument hint of the resolved command (slashArgumentHint) and the /btw panel's scroll rules (overlayBlocksGlobalTranscriptScroll,
// btwScrollMax, btwScrollOffset, btwContentRows, btwPanelRows).
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
  replay: { entry: 'mixdog-core-session session/pending.rs (slash tokens): resolve each recorded name and compare; compare the argument hint of each recorded input', normalised: {} },
  exclusions: { btwContentRows: "case 'btw scroll offsets…': `contentRows` (btwContentRows of a finished answer) is measureMarkdownRenderedRows, the Node TUI's markdown renderer; the core has none, so the replay takes the recorded number as the input of btw_panel_rows and compares panelRows, chromeRows, scrollMax and scrollOffset" },
});
process.exit(0);
