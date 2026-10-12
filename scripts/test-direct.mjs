#!/usr/bin/env node
// Explicit Node test options and file paths, without discovery or lane filters.
import { runNodeTests } from './lib/run-node-tests.mjs';

const argv = process.argv.slice(2);
// The same defaults as scripts/test.mjs: `mock.module` is still flag-gated on
// 22/24, and a suite that leaves a handle open must not hang the whole run.
// A flag the caller already passed (to node or to this script) is not repeated.
const given = new Set([...process.execArgv, ...argv]);
const unlessGiven = (flag) => (given.has(flag) ? [] : [flag]);

// Preserve parent Node flags such as heap limits and preload modules.
await runNodeTests(
  [
    ...process.execArgv,
    ...unlessGiven('--experimental-test-module-mocks'),
    '--test',
    ...unlessGiven('--test-force-exit'),
  ],
  argv
);
