#!/usr/bin/env node
// Golden twin of the setup tool's `open` action: the real `createSetupToolExecutor` for every
// open target (its answer when an attached UI takes the navigation, when none does, and when the
// session is unknown), the refusal for a target it does not list, and the UI notifications sent.
// `targets` is the executor's own list with the hint it prints when nothing is attached.
//
//   node benchmarks/rust-core/recorders/record-setup-open.mjs --tree <dir>
import { join } from 'node:path';

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { SETUP_OPEN_TARGETS } = await importFrom(tree, 'src/session-runtime/setup-tool/tool-defs.mjs');

async function run(args, { takes, session }) {
  const notified = [];
  const executor = createSetupToolExecutor({
    getApi: () => null,
    getConfig: () => ({}),
    getSessionId: () => session,
    notifySessionUi: (id, text, extra) => {
      notified.push({ id, text, extra });
      return takes;
    },
  });
  try {
    return { args, takes, session, notified, result: JSON.parse(await executor.execute(args, {})) };
  } catch (error) {
    return { args, takes, session, notified, error: String(error?.message ?? error) };
  }
}

const cases = [];
for (const target of SETUP_OPEN_TARGETS) {
  for (const takes of [true, false]) cases.push(await run({ action: 'open', target }, { takes, session: 'sess_a' }));
  cases.push(await run({ action: 'open', target }, { takes: true, session: '' }));
}
for (const target of ['nope', ' settings ', '  ', 'SETTINGS']) {
  cases.push(await run({ action: 'open', target }, { takes: true, session: 'sess_a' }));
}
cases.push(await run({ action: 'open' }, { takes: true, session: 'sess_a' }));
cases.push(await run({ action: 'open', target: 'settings' }, { takes: 'yes', session: 'sess_a' }));

// The hint each target prints with no UI attached, read from the answers above.
const targets = SETUP_OPEN_TARGETS.map((target) => {
  const hint = cases.find((c) => c.args.target === target && c.takes === false).result.note;
  return { target, note: hint };
});

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-open-twin.json'), {
  domain: 'setup-open-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-open.mjs',
  targets,
  cases,
});
console.log(`recorded ${cases.length} cases for ${targets.length} targets`);