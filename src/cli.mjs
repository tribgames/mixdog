#!/usr/bin/env node

import { run } from './app.mjs';

run(process.argv.slice(2)).then((code) => {
  if (Number.isInteger(code) && code !== 0) process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
