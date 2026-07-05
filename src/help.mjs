import { stdout } from 'node:process';

/** Help text printed by `--help`. */
export const HELP_LINES = [
  'mixdog — standalone mixdog CLI/TUI coding agent.',
  '',
  'Usage:',
  '  mixdog [--provider <name>] [--model <name>] [--readonly]',
  '  mixdog [--onboarding]      re-run the first-run setup wizard',
  '  mixdog <role> <message...>',
  '  mixdog --help',
  '',
  'Slash commands (inside mixdog):',
  '  /clear             reset the conversation and clear the screen',
  '  /compact           compact older conversation context',
  '  /model <name>      switch model/preset for subsequent turns',
  '  /OutputStyle [name] show or switch Lead output style',
  '  /providers         manage provider auth and local endpoints',
  '  /agents            show available workflow agents',
  '  /quit              quit (aliases: /exit, /q)',
  '',
  'History: use ↑ / ↓ to recall previous inputs.',
];

/** Print the help text without importing the REPL/runtime stack. */
export function printHelp(write = (s) => stdout.write(s)) {
  write(`${HELP_LINES.join('\n')}\n`);
}
