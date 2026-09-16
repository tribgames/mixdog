// Prettier — project-local only (a project that ships Prettier keeps it, and
// tidy never rewrites its config). `--list-different` checks, `--write` fixes.
import { createListFormatterRunner } from './shared.mjs';

export const runner = createListFormatterRunner({
  id: 'prettier',
  listArgs: ['--list-different'],
  writeArgs: ['--write'],
});

export default runner;
