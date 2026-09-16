// gofmt — toolchain formatter; `-l` lists, `-w` writes.
import { createListFormatterRunner } from './shared.mjs';

export const runner = createListFormatterRunner({
  id: 'gofmt',
  listArgs: ['-l'],
  writeArgs: ['-w'],
});

export default runner;
