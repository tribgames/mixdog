// shfmt — `-l` lists files that differ from the formatted form, `-w` writes.
import { createListFormatterRunner } from './shared.mjs';

export const runner = createListFormatterRunner({
  id: 'shfmt',
  listArgs: ['-l'],
  writeArgs: ['-w'],
});

export default runner;
