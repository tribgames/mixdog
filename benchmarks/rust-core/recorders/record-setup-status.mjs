#!/usr/bin/env node
// Golden twin of the setup tool's `status` dispatcher: the real `createSetupToolExecutor`'s
// answer for the self-contained domain (`capabilities`: the action field table, the status
// domains and the hand-offs), for the four desktop-hosted domains (forwarded to the desktop as
// `{ action: 'status', domain }`; here with no attached surface, so they answer the broker's
// refusal), and the domain list itself. The per-domain readers over the runtime facades are
// other owners' state and are recorded with their owners.
//
//   node benchmarks/rust-core/recorders/record-setup-status.mjs --tree <dir>
import { join } from 'node:path';

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { SETUP_STATUS_DOMAINS } = await importFrom(tree, 'src/session-runtime/setup-tool/tool-defs.mjs');

async function run(args, { session }) {
  const requests = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({}),
    getConfig: () => ({}),
    getSessionId: () => session,
    notifySessionUi: (id, text, extra) => {
      requests.push({ id, text, extra });
      return false;
    },
  });
  try {
    return { args, session, requests, result: JSON.parse(await executor.execute(args, {})) };
  } catch (error) {
    return { args, session, requests, error: String(error?.message ?? error) };
  }
}

const cases = [];
cases.push(await run({ action: 'status', domain: 'capabilities' }, { session: 'sess_a' }));
for (const domain of ['desktop', 'appearance', 'projects', 'connection']) {
  cases.push(await run({ action: 'status', domain }, { session: 'sess_a' }));
  cases.push(await run({ action: 'status', domain }, { session: '' }));
  cases.push(await run({ action: 'status', domain, detail: true }, { session: 'sess_a' }));
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-status-twin.json'), {
  domain: 'setup-status-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-status.mjs',
  domains: SETUP_STATUS_DOMAINS,
  cases,
});
console.log(`recorded ${cases.length} cases, ${SETUP_STATUS_DOMAINS.length} domains`);