#!/usr/bin/env node
// Whether an agent can have a home chat, as Node's real `readHomeAgent`
// (session-runtime/agent-home-delivery.mjs) decides it from the definition files: a store bot, the
// frontmatter `kind` of the user copy or the shipped role, the bot store being active, a copy that
// is unreadable, and the home thread's creation greeting for an unmarked user copy. Each world is
// written to a temp dir, every queried id is read by the real function, and the files in and the
// answers out are recorded; the greeting evidence (`greeted`) is recorded as input, as the
// definition loader's twin does.
//
//   node benchmarks/rust-core/recorders/record-home-agent.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/home-agent/golden.json
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'home-agent-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const { readHomeAgent } = await importFrom(tree, 'src/session-runtime/agent-home-delivery.mjs');
const { homeThreadEvidence } = await importFrom(tree, 'src/runtime/shared/agent-kind.mjs');

const md = (frontmatter, body = 'Do the work.') => {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n${body}\n` : `${body}\n`;
};
const DIALOG_BODY = [
  'You are a helper.',
  '',
  '- Help the user in a natural, friendly conversation, in the language they write in.',
  '- Ask a short question when a request is unclear, and say plainly when something is outside what you do.',
  '- Keep replies as short or as detailed as the moment needs.',
].join('\n');
const greeting = [{ role: 'user', content: '[mixdog-runtime] The user just created you as a helper.' }];
const split = JSON.stringify({ version: 1, bots: ['moved'] });

const worlds = [
  {
    name: 'bot store',
    shipped: { 'agents/reviewer/AGENT.md': md({ kind: 'agent' }) },
    data: {
      'bots/migration.json': split,
      'bots/store-a/AGENT.md': md({ kind: 'bot' }),
      'bots/mixy/AGENT.md': md({}),
      'agents/plain/AGENT.md': md({ kind: 'agent' }),
      'agents/odd/AGENT.md': md({ kind: 'robot' }),
      'agents/unmarked/AGENT.md': md({}),
    },
    ids: ['store-a', 'moved', 'mixy', '.hidden', 'plain', 'odd', 'unmarked', 'reviewer', 'ghost', 'lead', ''],
  },
  {
    name: 'kinds without a bot store',
    shipped: { 'agents/ship-plain/AGENT.md': md({}), 'agents/ship-agent/AGENT.md': md({ kind: 'agent' }), 'agents/ship-bot/AGENT.md': md({ kind: 'bot' }), 'agents/worker/AGENT.md': md({ kind: 'agent' }) },
    data: {
      'agents/robo/AGENT.md': md({ kind: ' BOT ' }),
      'agents/quoted/AGENT.md': md({ kind: '"bot"' }),
      'agents/worker/AGENT.md': md({ kind: 'bot' }),
      'agents/lead/AGENT.md': md({ kind: 'bot' }),
      'agents/wf/AGENT.md': md({ kind: 'Agent' }),
      'agents/other/AGENT.md': md({ kind: 'helper' }),
      'agents/ship-plain-user/AGENT.md': md({ kind: 'agent' }),
    },
    ids: ['robo', 'quoted', 'worker', 'lead', 'wf', 'other', 'ship-plain', 'ship-agent', 'ship-bot', 'ship-plain-user', 'maintainer', 'ghost'],
  },
  {
    name: 'unmarked copies decide by evidence',
    shipped: { 'agents/both/AGENT.md': md({}) },
    data: {
      'agents/both/AGENT.md': md({}),
      'agents/silent/AGENT.md': md({}),
      'agents/greeted/AGENT.md': md({}),
      'agents/dialog/AGENT.md': md({}, DIALOG_BODY),
      'agents/dialog/agent.json': JSON.stringify({ avatar: { emoji: 'x' } }),
      'agents/bare-avatar/AGENT.md': md({}),
      'agents/bare-avatar/agent.json': JSON.stringify({ avatar: { emoji: 'x' } }),
    },
    threads: { greeted: greeting },
    ids: ['both', 'silent', 'greeted', 'dialog', 'bare-avatar', 'ghost'],
  },
  {
    name: 'unmarked copies once the bot store is active',
    shipped: {},
    data: { 'bots/migration.json': split, 'agents/silent/AGENT.md': md({}), 'agents/greeted/AGENT.md': md({}) },
    threads: { greeted: greeting },
    ids: ['silent', 'greeted', 'ghost'],
  },
  {
    name: 'copies that cannot be read',
    shipped: { 'agents/dir-shipped/AGENT.md/keep': 'x', 'agents/fine/AGENT.md': md({}) },
    data: { 'agents/dir-user/AGENT.md/keep': 'x', 'agents/fine/AGENT.md': md({ kind: 'agent' }) },
    ids: ['dir-user', 'dir-shipped', 'fine'],
  },
];

const put = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
};

const recorded = [];
for (const [index, world] of worlds.entries()) {
  const root = join(sandbox, `world-${index}`);
  const shipped = join(root, 'shipped');
  const data = join(root, 'data');
  mkdirSync(shipped, { recursive: true });
  mkdirSync(data, { recursive: true });
  put(shipped, world.shipped);
  put(data, world.data);
  for (const [id, messages] of Object.entries(world.threads || {})) {
    mkdirSync(join(data, 'sessions'), { recursive: true });
    writeFileSync(join(data, 'sessions', `sess_home_${id}.json`), JSON.stringify({ id: `sess_home_${id}`, provider: 'x', model: 'y', profile: { homeAgent: id }, messages }));
  }
  recorded.push({
    name: world.name,
    shipped: world.shipped,
    data: world.data,
    threads: world.threads || {},
    greeted: Object.fromEntries(world.ids.map((id) => [id, homeThreadEvidence(data, id).greeted])),
    answers: Object.fromEntries(world.ids.map((id) => [id, readHomeAgent({ dataDir: data, shippedRoot: shipped, id })])),
  });
}
// The `dir-*` worlds hold an AGENT.md that is a folder: a file Node cannot read as text.
const finalOut = join(FIXTURES_ROOT, 'home-agent');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 readHomeAgent answers over definition files; `greeted` is the recorded home-thread evidence the Rust side is given',
  worlds: recorded,
});
writeSetManifest(out, {
  set: 'home-agent',
  recorder: 'benchmarks/rust-core/recorders/record-home-agent.mjs',
  command: 'node benchmarks/rust-core/recorders/record-home-agent.mjs --tree <tree>',
  extra: { worlds: recorded.length },
});
commitStage(out, finalOut);
console.log(`worlds=${recorded.length}`);
