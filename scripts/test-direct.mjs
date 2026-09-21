#!/usr/bin/env node
// Explicit Node test options and file paths, without discovery or lane filters.
import { runNodeTests } from './lib/run-node-tests.mjs';

await runNodeTests(['--test'], process.argv.slice(2));
