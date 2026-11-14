#!/usr/bin/env node
// Live smoke: the real desktop (Electron) against a real mixdogd on an isolated profile.
//   node scripts/live/smoke.mjs --core=<mixdogd> [--out=<dir>] [--iso-root=<dir>]
// Exits 0 when every check passes, 1 otherwise; <out>/summary.json holds {conditions, checks: [{name, ok, ms, detail}]}
// and the instance's history and logs are copied beside it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as browser from './checks/browser.mjs';
import * as hostClaim from './checks/host-claim.mjs';
import * as notify from './checks/notify.mjs';
import * as terminal from './checks/terminal.mjs';
import { conditions, openEnvironment } from './lib/env.mjs';
import { resolveLivePaths } from './lib/paths.mjs';

const identity = {
  name: 'core identity',
  run: async ({ env }) => {
    if (!env.coreCheck?.ours) throw new Error(`the serving core (pid ${env.coreCheck?.pid}, ${env.coreCheck?.executablePath}) is not the binary this run staged`);
    return `pid ${env.coreCheck.pid} ${env.coreCheck.executablePath}`;
  },
};

const CHECKS = [identity, hostClaim, terminal, browser, notify];

/** Runs each check once, in order; a thrown error is that check's failure and the next check still runs. */
async function runChecks(ctx, log = console.log) {
  const results = [];
  for (const check of CHECKS) {
    const started = Date.now();
    let result;
    try {
      result = { name: check.name, ok: true, ms: 0, detail: await check.run(ctx) };
    } catch (error) {
      result = { name: check.name, ok: false, ms: 0, detail: error instanceof Error ? error.message : String(error) };
    }
    result.ms = Date.now() - started;
    results.push(result);
    log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.ms} ms) ${result.detail}`);
  }
  return results;
}

const paths = resolveLivePaths();
const out = paths.out ?? join(paths.isoRoot, 'smoke-out');
mkdirSync(out, { recursive: true });
let results = [];
let failure = null;
const env = await openEnvironment({ ...paths, inspector: true });
try {
  results = await runChecks({ env });
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ conditions: conditions(env), checks: results }, null, 2)}\n`);
} catch (error) {
  failure = error;
} finally {
  await env.close(out);
}
if (failure) {
  console.error(failure.stack ?? String(failure));
  process.exit(1);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
