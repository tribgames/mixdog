#!/usr/bin/env node
// Launcher of the platform's `mixdogd`: runs it with this process's arguments
// and stdio, and exits as it does.
import { spawn } from 'node:child_process';

import { resolveMixdogd } from '../platform.mjs';

let binary;
try {
  binary = resolveMixdogd();
} catch (error) {
  console.error(`mixdogd: ${error.message}`);
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`mixdogd: could not start ${binary}: ${error.message}`);
  process.exit(1);
});
// A terminal's Ctrl-C reaches both processes; the child decides how to stop.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
