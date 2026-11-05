#!/usr/bin/env node
// Golden twin of the connector text helpers: the curated selection triggers
// (`runtime/shared/connector-triggers.mjs`) and the account instructions
// (`runtime/shared/connector-accounts.mjs`). Rust `mixdog_services::connectors` must equal
// every answer, including for the odd inputs below.
//
//   node benchmarks/rust-core/recorders/record-connectors.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const triggers = await importFrom(tree, 'src/runtime/shared/connector-triggers.mjs');
const accounts = await importFrom(tree, 'src/runtime/shared/connector-accounts.mjs');

const known = Object.keys(triggers.CONNECTOR_TRIGGERS);
const ids = new Set(['', 'unknown', 'github-', '-2', 'github--2', 'x-2', 'github-2-3', 'github_12', 'github-2a', 'github-٣', 'Gmail ', ' gmail',
  'ｇithub', 'lİnear', 'LİNEAR-2', 'ſentry', 'ſtripe', 'sentrY', 'googlecalendar', 'GOOGLE_CALENDAR', 'google calendar 2', 'hugging_face-3', 'huggingface-0']);
for (const id of known) {
  for (const variant of [id, id.toUpperCase(), id.replace(/-/g, '_'), id.replace(/-/g, ''), `${id}-2`, `${id}_3`, `${id}-10`, `${id} `, `x${id}`]) ids.add(variant);
}
const triggerCases = [...ids].map((id) => ({ id, trigger: triggers.connectorTrigger(id) }));
triggerCases.push({ id: null, trigger: triggers.connectorTrigger(null) }, { id: undefined, trigger: triggers.connectorTrigger(undefined) });

const lists = [
  [], [{ email: '' }], [{ email: 'a@x.com' }], [{ email: 'a@x.com', note: '' }], [{ email: 'a@x.com', note: 'needs sign-in' }],
  [{ email: 'a@x.com' }, { email: '' }, { email: 'b@x.com', note: 'x' }], [{ email: 'a@x.com' }, { email: 'b@x.com' }],
  [{ email: 'a@x.com', note: 'a, b' }, { email: 'c@x.com' }], [{ email: 'a@x.com', note: 'n (m)' }, { email: 'c@x.com', note: '(z)' }],
  [{ email: ' a@x.com ' }, { email: 'b@x.com' }], [{ email: 'a é@x.com', note: 'né' }], [{ email: 'a@x.com\nb' }, { email: 'c@x.com' }],
  [{ email: 'a@x.com', note: 'multi\nline' }, { email: 'c@x.com' }], [{ email: 'a (b@x.com' }, { email: 'c)@x.com' }],
  [{ email: 'a\u00a0@x.com' }, { email: '\u2003b@x.com' }], [{ email: 'a@x.com. `account`' }, { email: 'b@x.com' }],
  [null, { email: 'a@x.com' }, undefined, {}], 'not a list', null, undefined,
];
const accountCases = lists.map((accountsIn) => {
  const instructions = accounts.connectorAccountsInstructions(accountsIn);
  return { accounts: accountsIn === undefined ? { absent: true } : accountsIn, instructions: instructions ?? null, parsed: accounts.accountsOfInstructions(instructions) };
});
const raw = [
  'nothing', '', 'Accounts: a@x.com. `account` may be left out.', 'Accounts: a@x.com (n). `account` picks one',
  'Accounts: a@x.com (n), b@x.com. `account` x. `account` y', 'Accounts: . `account`', 'Accounts: a. `account`',
  'Accounts: a\nb. `account` x', 'Accounts: a\r. `account` x', 'Accounts: a\u2028b. `account` x', 'Accounts: a (x\ny). `account` x',
  'Accounts: a (x), b (y (z)). `account` x', 'Accounts:  a ,  b . `account` x', 'Accounts: \u00a0a\u00a0, \ufeffb. `account` x',
  'Accounts: a ( ). `account` x', 'Accounts: (x). `account` x', 'Accounts: a (x) , b. `account` x', 'x Accounts: a. `account`',
  'Accounts: a,b, c. `account` x', 'Accounts: a (x)(y). `account` x',
];
const rawCases = raw.map((text) => ({ text, parsed: accounts.accountsOfInstructions(text) }));
rawCases.push({ text: { absent: true }, parsed: accounts.accountsOfInstructions(undefined) }, { text: { number: 42 }, parsed: accounts.accountsOfInstructions(42) });

writeJson(join(FIXTURES_ROOT, 'connectors', 'connector-text-twin.json'), {
  domain: 'connector-text-twin',
  recorder: 'benchmarks/rust-core/recorders/record-connectors.mjs',
  maxChars: triggers.CONNECTOR_TRIGGER_MAX_CHARS,
  triggers: triggers.CONNECTOR_TRIGGERS,
  triggerCases,
  accountCases,
  rawCases,
});
writeSetManifest(join(FIXTURES_ROOT, 'connectors'), {
  set: 'connectors',
  recorder: 'benchmarks/rust-core/recorders/record-connectors.mjs',
  command: 'node benchmarks/rust-core/recorders/record-connectors.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${triggerCases.length} trigger, ${accountCases.length} account and ${rawCases.length} raw cases`);
