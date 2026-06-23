#!/usr/bin/env node

import { run } from './app.mjs';

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
