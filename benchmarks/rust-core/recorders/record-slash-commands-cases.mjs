#!/usr/bin/env node
// Recording of tui/app/slash-commands.test.mjs (b6f10295a), the two cases whose behaviour stays in the product: the slash command
// registry's alias resolution (normalizeSlashCommandName) and the argument hint of the resolved command (slashArgumentHint). The two
// /btw panel cases (overlayBlocksGlobalTranscriptScroll, btwScroll*) are Node-TUI-only and are not recorded.
//
//   node benchmarks/rust-core/recorders/record-slash-commands-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('slash-commands-cases', import.meta.url);
const { normalizeSlashCommandName, slashArgumentHint } = await set.load('src/tui/app/slash-commands.mjs');

await set.run('a command name resolves through its aliases, and an unknown one stays as typed', () => ({
  names: ['clear', 'NEW', 'Projects', 'nope', '', undefined].map((input) => ({ input: input === undefined ? { undefined: true } : input, result: normalizeSlashCommandName(input) })),
}));
await set.run('the argument hint comes from the resolved command, only after a trailing space', () => ({
  hints: ['/model ', '/autoclear ', '/projects ', '/clear ', '/nope ', '/model', '/model x ', ''].map((input) => ({ input, hint: slashArgumentHint(input) })),
}));

await set.finish({
  entry: { runs: 'src/tui/app/slash-commands.mjs normalizeSlashCommandName and slashArgumentHint over the real command registry', notRun: 'the /btw panel cases (overlayBlocksGlobalTranscriptScroll, btwScrollMax/Offset, btwContentRows/PanelRows) are Node TUI code: not recorded' },
  replay: { entry: 'mixdog-core-session session/pending.rs (slash tokens): resolve each recorded name and compare; compare the argument hint of each recorded input', normalised: {} },
});
process.exit(0);
