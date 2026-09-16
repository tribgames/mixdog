// gofumpt — stricter gofmt; same `-l` / `-w` contract.
import { createListFormatterRunner } from './shared.mjs';

export const runner = createListFormatterRunner({
  id: 'gofumpt',
  listArgs: ['-l'],
  writeArgs: ['-w'],
});

export default runner;
