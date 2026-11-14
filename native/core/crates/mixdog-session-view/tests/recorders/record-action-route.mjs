#!/usr/bin/env node
// Records the session action router of the TypeScript client (packages/protocol-client/src/actions/action-route.mjs) over every
// action with representative argument lists and three call contexts: the golden the Rust router (src/action_route.rs) is
// compared with by tests/action_route_twin.rs.
//
//   node record-action-route.mjs --tree <tree root> [--out file | --check file]
//
// Without --out or --check the recording goes to stdout. --check writes nothing and exits 1 when the file differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const tree = flag('--tree');
if (!tree) {
  console.error('record-action-route: --tree <tree root> is required');
  process.exit(2);
}
const routeUrl = pathToFileURL(resolve(tree, 'packages/protocol-client/src/actions/action-route.mjs')).href;
const { resolveAction, SESSION_ACTIONS } = await import(routeUrl);

const options = { route: 'r', compact: true, restoreFiles: false };
const ARGS = {
  none: [],
  one: ['a1'],
  two: ['a1', 'a2'],
  three: ['a1', 'a2', 'a3'],
  nullFirst: [null, 'a2'],
  goalSet: [{ action: 'set', objective: 'o' }],
  goalClear: [{ action: 'clear' }],
  goalOther: [{ action: 'status' }, 'a2'],
  objects: [{ x: 1 }, options],
  idAndOptions: ['a1', options],
  tooMany: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
};
const CONTEXTS = {
  bound: { threadId: 't1' },
  unbound: {},
  empty: { threadId: '' },
};
// Every argument list under the bound context; the other contexts see the lists that tell them apart.
const PLAN = { bound: Object.keys(ARGS), unbound: ['none', 'two', 'idAndOptions'], empty: ['one', 'none'] };

const actions = [...SESSION_ACTIONS, 'noSuchAction'];
const entries = [];
for (const action of actions) {
  for (const [context, names] of Object.entries(PLAN)) {
    for (const name of names) {
      const args = ARGS[name];
      let result;
      try {
        const { method, params } = resolveAction(action, args, CONTEXTS[context]);
        result = { method, params: JSON.parse(JSON.stringify(params)) };
      } catch (error) {
        result = { error: { message: error.message, code: error.code ?? null } };
      }
      entries.push({ action, context, args: name, result });
    }
  }
}
// One entry per line, so a difference reads as one line of a diff.
const text = [
  '{',
  ` "actions": ${SESSION_ACTIONS.length},`,
  ` "args": ${JSON.stringify(ARGS)},`,
  ` "contexts": ${JSON.stringify(CONTEXTS)},`,
  ' "entries": [',
  entries.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n'),
  ' ]',
  '}',
  '',
].join('\n');
const check = flag('--check');
const out = flag('--out');
if (check) {
  if (readFileSync(resolve(check), 'utf8').replace(/\r\n/g, '\n') !== text) {
    console.error(`record-action-route: ${check} differs from the recording of ${tree}`);
    process.exit(1);
  }
} else if (out) writeFileSync(resolve(out), text);
else process.stdout.write(text);
