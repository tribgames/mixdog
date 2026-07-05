#!/usr/bin/env node

import { run } from './app.mjs';

run(process.argv.slice(2)).then((code) => {
  const exitCode = Number.isInteger(code) ? code : 0;
  process.exit(exitCode);
}).catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
