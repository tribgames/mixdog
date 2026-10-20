// The one-time bots/ split over genuine v1.2.6 / v1.3.0 profiles: bots are
// copied (never moved), Mixy gets its own folder and route, the Lead and
// every transcript stay byte-for-byte, and a second run does nothing.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { backupUserData } from './user-data-guard.mjs';
import {
  BOT_SPLIT_BACKUP_DIRS,
  MIXY_LEGACY_HOME_SESSION_ID,
  migrateBotsToOwnStore,
  migratedBotIds,
  readBotMigration,
} from './bot-split-migration.mjs';

const SHIPPED = join(process.cwd(), 'src');
const MASCOT = { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' };
const LEAD_ROUTE = { provider: 'anthropic-oauth', model: 'claude-opus-5' };

function profile(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-bot-split-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function writeAgent(dataDir, id, { frontmatter = '', body = `You are ${id}.`, manifest = {} } = {}) {
  const dir = join(dataDir, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), `---\nname: ${id}\ndescription: ${id} job\n${frontmatter}---\n\n${body}\n`);
  writeFileSync(
    join(dir, 'agent.json'),
    `${JSON.stringify({ name: id, description: `${id} job`, ...manifest }, null, 2)}\n`
  );
  return dir;
}

// v1.3.0 agentBodyFromBrief (the bot dialog's empty 일하는 방식).
const dialogBody = (id) =>
  [
    `# ${id}`,
    `${id} job`,
    [
      '- Help the user with this role in a natural, friendly conversation, in the language they write in.',
      '- Ask a short question when a request is unclear, and say plainly when something is outside what you do.',
      '- Keep replies as short or as detailed as the moment needs.',
    ].join('\n'),
  ].join('\n\n');

const greeting = (name, mixy = false) =>
  `[mixdog-runtime] The user just created you as ${mixy ? 'their primary agent' : 'a new agent'} named "${name}".\nTake the first turn now.`;

function writeThread(dataDir, id, messages, route = LEAD_ROUTE) {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  const sessionId = `sess_home_${id}`;
  writeFileSync(
    join(dataDir, 'sessions', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      ...route,
      profile: id === 'lead' ? {} : { homeAgent: id },
      messages: [{ role: 'system', content: 'sys' }, ...messages],
    })
  );
}
const chat = [
  { role: 'user', content: '안녕' },
  { role: 'assistant', content: '안녕하세요' },
];

function tree(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .flatMap((name) => {
        try {
          return [[name, readFileSync(join(dir, name), 'utf8')]];
        } catch {
          return [];
        }
      })
  );
}

const run = (dataDir, extra = {}) =>
  migrateBotsToOwnStore({
    dataDir,
    shippedRoot: SHIPPED,
    routeOf: (id) => (id === 'dialog-greeted' ? { provider: 'openai', model: 'gpt-6' } : null),
    leadRoute: LEAD_ROUTE,
    ...extra,
  });

test('A (≤1.2.6 → 1.3.1): nothing is a bot; no bots/ entries, Mixy undecided stays unmigrated', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'db-expert');
  writeAgent(dataDir, 'doc-writer');
  const before = tree(join(dataDir, 'agents'));
  const result = run(dataDir);
  assert.deepEqual(result, { skipped: false, bots: [], mixy: false, changed: [] });
  assert.deepEqual(tree(join(dataDir, 'agents')), before);
  assert.deepEqual(readdirSync(join(dataDir, 'bots')), ['migration.json']);
});

test('B (1.2.6 → 1.3.0 → 1.3.1): old agents opened/chatted/faced stay agents; their threads stay whole', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'db-expert', { manifest: { avatar: MASCOT } });
  writeAgent(dataDir, 'helper');
  writeAgent(dataDir, 'opened');
  writeThread(dataDir, 'db-expert', chat);
  writeThread(dataDir, 'helper', chat);
  writeThread(dataDir, 'opened', []);
  // The untouched automatic Mixy: no name, never talked to.
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  const agents = tree(join(dataDir, 'agents'));
  const sessions = tree(join(dataDir, 'sessions'));
  assert.deepEqual(run(dataDir), { skipped: false, bots: [], mixy: false, changed: [] });
  assert.deepEqual(tree(join(dataDir, 'agents')), agents);
  assert.deepEqual(tree(join(dataDir, 'sessions')), sessions, 'every transcript byte-for-byte');
  assert.equal(existsSync(join(dataDir, 'bots', 'mixy')), false, 'the unused automatic Mixy → the create dialog');
});

test('B: an automatic Mixy the user chatted with moves to bots/mixy on its thread’s route; the Lead is untouched', (t) => {
  const dataDir = profile(t);
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  writeThread(dataDir, 'lead', chat, { provider: 'openai-oauth', model: 'gpt-6' });
  const thread = readFileSync(join(dataDir, 'sessions', 'sess_home_lead.json'), 'utf8');
  const result = run(dataDir, { leadRoute: LEAD_ROUTE });
  assert.equal(result.mixy, true);
  const mixy = JSON.parse(readFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), 'utf8'));
  assert.deepEqual(mixy, {
    created: true,
    route: { provider: 'openai-oauth', model: 'gpt-6' },
    homeSessionId: MIXY_LEGACY_HOME_SESSION_ID,
  });
  assert.equal(readFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), 'utf8'), '{\n  "created": true\n}\n');
  assert.equal(readFileSync(join(dataDir, 'sessions', 'sess_home_lead.json'), 'utf8'), thread, 'messages kept');
  assert.equal(readBotMigration(dataDir).mixyHomeSessionId, 'sess_home_lead');
});

test('C (fresh 1.3.0 → 1.3.1): dialog, setup-tool and marked bots are copied with their routes; originals stay', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'dialog-greeted', { body: 'Plan my week.', manifest: { avatar: MASCOT } });
  writeThread(dataDir, 'dialog-greeted', [{ role: 'user', content: greeting('dialog-greeted') }, ...chat]);
  writeAgent(dataDir, 'dialog-silent', { body: dialogBody('dialog-silent'), manifest: { avatar: MASCOT } });
  writeFileSync(join(dataDir, 'agents', 'dialog-silent', 'PERSONA.md'), 'Warm.\n');
  writeAgent(dataDir, 'tool-greeted');
  writeThread(dataDir, 'tool-greeted', [{ role: 'user', content: greeting('tool-greeted') }]);
  writeAgent(dataDir, 'tool-silent');
  writeThread(dataDir, 'tool-silent', chat);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n' });
  writeAgent(dataDir, 'triage', { frontmatter: 'kind: agent\n', manifest: { avatar: MASCOT } });
  // A deleted 1.3.0 bot keeps its archived chat: it moves too.
  const archived = writeAgent(dataDir, 'gone', { frontmatter: 'kind: bot\n' });
  writeFileSync(join(archived, 'AGENT.md.archived'), readFileSync(join(archived, 'AGENT.md')));
  rmSync(join(archived, 'AGENT.md'));
  writeFileSync(join(archived, '.deleted'), 'deleted\n');
  // Mixy made in the dialog: named, greeted, with a persona.
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(
    join(dataDir, 'agents', 'lead', 'agent.json'),
    `${JSON.stringify({ created: true, name: 'Mixy', description: 'Primary assistant' }, null, 2)}\n`
  );
  writeFileSync(join(dataDir, 'agents', 'lead', 'PERSONA.md'), 'Cheerful.\n');
  writeThread(dataDir, 'lead', [{ role: 'user', content: greeting('Mixy', true) }]);
  const agents = tree(join(dataDir, 'agents'));
  const sessions = tree(join(dataDir, 'sessions'));
  let backups = 0;
  const result = run(dataDir, { backup: () => backups++ });
  assert.deepEqual(result.bots, ['dialog-greeted', 'dialog-silent', 'gone', 'marked', 'tool-greeted']);
  assert.equal(result.mixy, true);
  assert.equal(backups, 1, 'backed up first');
  assert.deepEqual(tree(join(dataDir, 'agents')), agents, 'copied, never moved');
  assert.deepEqual(tree(join(dataDir, 'sessions')), sessions, 'every transcript byte-for-byte');
  assert.deepEqual([...migratedBotIds(dataDir)].sort(), result.bots);
  // Each copy is whole; the route travels with the bot.
  const copy = tree(join(dataDir, 'bots', 'dialog-silent'));
  assert.equal(copy['PERSONA.md'], 'Warm.\n');
  assert.equal(copy['AGENT.md'], agents[join('dialog-silent', 'AGENT.md')]);
  assert.deepEqual(JSON.parse(tree(join(dataDir, 'bots', 'dialog-greeted'))['agent.json']).route, {
    provider: 'openai',
    model: 'gpt-6',
  });
  assert.ok(existsSync(join(dataDir, 'bots', 'gone', '.deleted')));
  const mixy = JSON.parse(readFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), 'utf8'));
  assert.equal(mixy.name, 'Mixy');
  assert.deepEqual(mixy.route, LEAD_ROUTE, "Mixy's own route: its thread's");
  assert.equal(readFileSync(join(dataDir, 'bots', 'mixy', 'PERSONA.md'), 'utf8'), 'Cheerful.\n');
  // Idempotent: a second start does nothing.
  const after = tree(join(dataDir, 'bots'));
  assert.equal(run(dataDir, { backup: () => backups++ }).skipped, true);
  assert.deepEqual(tree(join(dataDir, 'bots')), after);
  assert.equal(backups, 1);
});

test('a failure leaves the profile as it was and writes no manifest; the next run succeeds', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n' });
  writeAgent(dataDir, 'other', { frontmatter: 'kind: bot\n' });
  const logs = [];
  let calls = 0;
  const failing = run(dataDir, {
    routeOf: () => {
      calls += 1;
      if (calls === 2) throw new Error('config unreadable');
      return null;
    },
    log: (line) => logs.push(line),
  });
  assert.equal(failing.failed, true);
  assert.match(logs[0], /migration failed; the profile is unchanged/);
  assert.equal(readBotMigration(dataDir), null);
  assert.deepEqual(readdirSync(join(dataDir, 'bots')), [], 'no copy and no staging left');
  assert.deepEqual(run(dataDir).bots, ['marked', 'other']);
});

// --- Conflicts ---
const later = (file) => {
  const future = new Date(Date.now() + 60_000);
  utimesSync(file, future, future);
};

test('1: a bots/<id> already there (an earlier run, hand-made, restored) is kept as it is and adopted', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n', body: 'OLD BODY' });
  mkdirSync(join(dataDir, 'bots', 'marked'), { recursive: true });
  writeFileSync(join(dataDir, 'bots', 'marked', 'AGENT.md'), '---\nname: marked\n---\n\nNEWER BODY\n');
  const before = tree(join(dataDir, 'bots', 'marked'));
  assert.deepEqual(run(dataDir).bots, ['marked']);
  assert.deepEqual(tree(join(dataDir, 'bots', 'marked')), before, 'never overwritten');
  assert.deepEqual(readdirSync(join(dataDir, 'bots')).sort(), ['marked', 'migration.json'], 'no duplicate, no staging');
});

test('3: a 1.3.0 round trip loses nothing: edits and new bots made in agents/ are picked up; bots/ edits win', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'edited', { frontmatter: 'kind: bot\n' });
  writeAgent(dataDir, 'both', { frontmatter: 'kind: bot\n' });
  writeAgent(dataDir, 'restored', { frontmatter: 'kind: bot\n' });
  run(dataDir, { routeOf: () => ({ provider: 'openai', model: 'gpt-6' }) });
  // On 1.3.1: the user edits `both` in bots/ and changes `edited`'s model.
  writeFileSync(join(dataDir, 'bots', 'both', 'PERSONA.md'), 'EDITED ON 1.3.1\n');
  const editedJson = join(dataDir, 'bots', 'edited', 'agent.json');
  writeFileSync(
    editedJson,
    JSON.stringify({ ...JSON.parse(readFileSync(editedJson, 'utf8')), route: { provider: 'openai', model: 'gpt-7' } })
  );
  // Downgraded to 1.3.0 (writes agents/ only): edits two bots, makes a new
  // bot in its dialog; a restored old copy of a third keeps its old times.
  for (const id of ['edited', 'both']) {
    const file = join(dataDir, 'agents', id, 'AGENT.md');
    writeFileSync(file, `---\nname: ${id}\n---\n\nEDITED ON 1.3.0\n`);
    later(file);
  }
  writeFileSync(join(dataDir, 'agents', 'restored', 'AGENT.md'), '---\nname: restored\n---\n\nOLD RESTORED\n');
  const past = new Date(Date.now() - 86_400_000);
  utimesSync(join(dataDir, 'agents', 'restored', 'AGENT.md'), past, past);
  writeAgent(dataDir, 'made-on-130', { body: dialogBody('made-on-130'), manifest: { avatar: MASCOT } });
  const logs = [];
  const result = run(dataDir, { log: (line) => logs.push(line) });
  assert.deepEqual(result.bots, ['both', 'edited', 'made-on-130', 'restored']);
  assert.deepEqual(result.changed.sort(), ['edited', 'made-on-130']);
  // The 1.3.0 edit reached bots/, with the 1.3.1 model kept.
  assert.match(readFileSync(join(dataDir, 'bots', 'edited', 'AGENT.md'), 'utf8'), /EDITED ON 1.3.0/);
  assert.equal(JSON.parse(readFileSync(editedJson, 'utf8')).route.model, 'gpt-7');
  // Edited on both sides: bots/ wins, the 1.3.0 edit stays in agents/.
  assert.doesNotMatch(readFileSync(join(dataDir, 'bots', 'both', 'AGENT.md'), 'utf8'), /EDITED ON 1.3.0/);
  assert.match(logs.join('\n'), /both: edited in both agents\/ and bots\/; the bots\/ copy is kept/);
  // An older restored original never overwrites the copy.
  assert.doesNotMatch(readFileSync(join(dataDir, 'bots', 'restored', 'AGENT.md'), 'utf8'), /OLD RESTORED/);
  assert.ok(existsSync(join(dataDir, 'bots', 'made-on-130', 'AGENT.md')), 'a bot made on 1.3.0 joins the store');
  assert.equal(run(dataDir).skipped, true, 'and then nothing more to do');
});

test('3: Mixy named on 1.3.0 after the split fills bots/mixy, keeping the route and flag 1.3.1 wrote there', (t) => {
  const dataDir = profile(t);
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  assert.equal(run(dataDir).mixy, false, 'unused: not migrated');
  // 1.3.1 wrote Mixy's own route and flag into bots/mixy.
  mkdirSync(join(dataDir, 'bots', 'mixy'), { recursive: true });
  const route = { provider: 'openai', model: 'gpt-6' };
  writeFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), JSON.stringify({ created: true, route }));
  // Back on 1.3.0 the user names Mixy and writes its persona.
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), JSON.stringify({ created: true, name: 'Navi' }));
  writeFileSync(join(dataDir, 'agents', 'lead', 'PERSONA.md'), 'Calm.\n');
  assert.equal(run(dataDir).mixy, true);
  const mixy = JSON.parse(readFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), 'utf8'));
  assert.equal(mixy.name, 'Navi');
  assert.deepEqual(mixy.route, route, '1.3.1’s own route kept');
  assert.equal(readFileSync(join(dataDir, 'bots', 'mixy', 'PERSONA.md'), 'utf8'), 'Calm.\n');
  // A later 1.3.0 rename reaches an untouched bots/mixy; a 1.3.1 rename wins.
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), JSON.stringify({ created: true, name: 'Momo' }));
  later(join(dataDir, 'agents', 'lead', 'agent.json'));
  run(dataDir);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), 'utf8')).name, 'Momo');
  const mixyJson = join(dataDir, 'bots', 'mixy', 'agent.json');
  writeFileSync(mixyJson, JSON.stringify({ ...JSON.parse(readFileSync(mixyJson, 'utf8')), name: 'Kept' }));
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), JSON.stringify({ created: true, name: 'Lost' }));
  later(join(dataDir, 'agents', 'lead', 'agent.json'));
  run(dataDir, { log: () => {} });
  assert.equal(JSON.parse(readFileSync(mixyJson, 'utf8')).name, 'Kept');
});

test('4: two runtimes starting at once end with one whole copy per bot and no leftovers', async (t) => {
  const dataDir = profile(t);
  const ids = Array.from({ length: 12 }, (_, index) => `bot-${index}`);
  for (const id of ids) writeAgent(dataDir, id, { frontmatter: 'kind: bot\n', body: `${id} body\n`.repeat(200) });
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'runtime', 'shared', 'bot-split-migration.mjs')).href;
  const script = `const { migrateBotsToOwnStore } = await import(${JSON.stringify(moduleUrl)});
    const result = migrateBotsToOwnStore({ dataDir: ${JSON.stringify(dataDir)}, shippedRoot: ${JSON.stringify(SHIPPED)} });
    process.stdout.write(JSON.stringify(result));`;
  const runner = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
    });
  const results = await Promise.all([runner(), runner()]);
  for (const result of results) assert.equal(result.failed, undefined);
  assert.deepEqual(
    readdirSync(join(dataDir, 'bots')).sort(),
    [...ids, 'migration.json'].sort(),
    'no staging or set-aside folder left'
  );
  for (const id of ids) {
    const copy = tree(join(dataDir, 'bots', id));
    assert.equal(copy['AGENT.md'], readFileSync(join(dataDir, 'agents', id, 'AGENT.md'), 'utf8'), `${id} whole`);
  }
  assert.deepEqual(readBotMigration(dataDir).bots, ids.sort());
});

test('4: a crash’s leftovers are cleaned on the next start; a live run’s are not; a half swap is put back', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n' });
  run(dataDir);
  const bots = join(dataDir, 'bots');
  const dead = 2 ** 22 + 17;
  mkdirSync(join(bots, `.ghost.${dead}-1.staging`), { recursive: true });
  // A swap that died between its two renames: the bot sits aside as `.old`.
  writeFileSync(join(bots, 'marked', 'PERSONA.md'), 'kept\n');
  renameSync(join(bots, 'marked'), join(bots, `.marked.${dead}-1.old`));
  // Under the migration lock no run is live, whoever's pid a leftover names.
  mkdirSync(join(bots, `.busy.${process.ppid}-1.staging`), { recursive: true });
  run(dataDir);
  assert.equal(readFileSync(join(bots, 'marked', 'PERSONA.md'), 'utf8'), 'kept\n', 'the set-aside bot is back');
  assert.equal(existsSync(join(bots, `.ghost.${dead}-1.staging`)), false);
  assert.equal(existsSync(join(bots, `.busy.${process.ppid}-1.staging`)), false);
  // A run that set a bot aside and died before its commit: the bot as it was comes back.
  writeFileSync(join(bots, 'marked', 'PERSONA.md'), 'uncommitted copy\n');
  mkdirSync(join(bots, `.marked.${dead}-2.old`), { recursive: true });
  writeFileSync(join(bots, `.marked.${dead}-2.old`, 'PERSONA.md'), 'before\n');
  run(dataDir);
  assert.equal(readFileSync(join(bots, 'marked', 'PERSONA.md'), 'utf8'), 'before\n');
  assert.deepEqual(readdirSync(bots).sort(), ['marked', 'migration.json']);
});

function backupRoot(t) {
  const backups = mkdtempSync(join(tmpdir(), 'mixdog-bot-split-backups-'));
  const saved = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backups;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = saved;
    rmSync(backups, { recursive: true, force: true });
  });
  return backups;
}
const splitBackup = (dataDir) => () => backupUserData(dataDir, 'bot-split', { dirs: BOT_SPLIT_BACKUP_DIRS });

test('5: the split’s backup carries agents/ and bots/ (routine ones do not); a lost bots/ is rebuilt', (t) => {
  const dataDir = profile(t);
  const backups = backupRoot(t);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n' });
  writeFileSync(join(dataDir, 'mixdog-config.json'), '{}');
  run(dataDir, { backup: splitBackup(dataDir) });
  const copied = readdirSync(backups, { recursive: true }).map(String);
  assert.ok(copied.some((name) => name.endsWith('mixdog-config.json')));
  assert.ok(
    copied.some((name) => /[\\/]agents[\\/]marked[\\/]AGENT\.md$/.test(name)),
    'the originals'
  );
  // A routine snapshot keeps to its small set.
  const routine = backupUserData(dataDir, 'snapshot').copied;
  assert.ok(!routine.some((name) => /[\\/](agents|bots)[\\/]/.test(name)));
  // The whole bots/ removed by hand: the next start copies the bots again.
  rmSync(join(dataDir, 'bots'), { recursive: true, force: true });
  assert.deepEqual(run(dataDir).bots, ['marked']);
  assert.ok(existsSync(join(dataDir, 'bots', 'marked', 'AGENT.md')));
});

test('6: a re-sync that fails part-way undoes its own copies and keeps the manifest; the next one succeeds', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n' });
  run(dataDir);
  const manifest = readFileSync(join(dataDir, 'bots', 'migration.json'), 'utf8');
  writeAgent(dataDir, 'a-new', { frontmatter: 'kind: bot\n' });
  writeAgent(dataDir, 'b-new', { frontmatter: 'kind: bot\n' });
  const failing = run(dataDir, {
    routeOf: (id) => {
      if (id === 'b-new') throw new Error('disk full');
      return null;
    },
    log: () => {},
  });
  assert.equal(failing.failed, true);
  assert.equal(existsSync(join(dataDir, 'bots', 'a-new')), false, "this run's copy is undone");
  assert.equal(readFileSync(join(dataDir, 'bots', 'migration.json'), 'utf8'), manifest);
  assert.deepEqual(run(dataDir).bots, ['a-new', 'b-new', 'marked']);
});

test('7: a bot deleted for good in bots/ never comes back from its agents/ original, even edited there', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'marked', { frontmatter: 'kind: bot\n' });
  run(dataDir);
  rmSync(join(dataDir, 'bots', 'marked'), { recursive: true, force: true });
  const file = join(dataDir, 'agents', 'marked', 'AGENT.md');
  writeFileSync(file, '---\nname: marked\nkind: bot\n---\n\nEDITED\n');
  later(file);
  run(dataDir);
  assert.equal(existsSync(join(dataDir, 'bots', 'marked')), false);
  assert.deepEqual([...migratedBotIds(dataDir)], ['marked'], 'its id stays reserved');
});

// --- Interleavings ---
const MODULE_URL = pathToFileURL(join(process.cwd(), 'src', 'runtime', 'shared', 'bot-split-migration.mjs')).href;
const editJson = (file, edit) => {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  edit(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  later(file);
};

test('8: a second process never migrates while one is: it waits, then reads the profile; a failure undoes only its own run', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'kept', { frontmatter: 'kind: bot\n' });
  // B commits first.
  run(dataDir);
  const committed = tree(join(dataDir, 'bots', 'kept'));
  writeAgent(dataDir, 'a-new', { frontmatter: 'kind: bot\n' });
  writeAgent(dataDir, 'b-new', { frontmatter: 'kind: bot\n' });
  // A copies a-new, then — before its commit — another process starts (it
  // must not migrate meanwhile) and A fails.
  let second = null;
  const failing = run(dataDir, {
    routeOf: (id) => {
      if (id !== 'b-new') return null;
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { migrateBotsToOwnStore } = await import(${JSON.stringify(MODULE_URL)});
          const result = migrateBotsToOwnStore({ dataDir: ${JSON.stringify(dataDir)}, shippedRoot: ${JSON.stringify(SHIPPED)}, lockWaitMs: 300, log: () => {} });
          process.stdout.write(JSON.stringify(result));`,
        ],
        { encoding: 'utf8' }
      );
      second = JSON.parse(child.stdout);
      throw new Error('disk full');
    },
    log: () => {},
  });
  assert.deepEqual(second, { skipped: false, failed: true, busy: true, bots: ['kept'], mixy: false });
  assert.equal(failing.failed, true);
  assert.deepEqual(readdirSync(join(dataDir, 'bots')).sort(), ['kept', 'migration.json'], "only A's copy is undone");
  assert.deepEqual(tree(join(dataDir, 'bots', 'kept')), committed, "B's committed bot is untouched");
  assert.deepEqual(readBotMigration(dataDir).bots, ['kept']);
  assert.deepEqual(run(dataDir).bots, ['a-new', 'b-new', 'kept']);
});

test('9: a failure after the manifest is published undoes nothing; the set-aside copy goes on a later start', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'edited', { frontmatter: 'kind: bot\n' });
  run(dataDir);
  const file = join(dataDir, 'agents', 'edited', 'AGENT.md');
  writeFileSync(file, '---\nname: edited\nkind: bot\n---\n\nEDITED ON 1.3.0\n');
  later(file);
  const logs = [];
  const result = run(dataDir, {
    afterPublish: () => {
      throw new Error('EBUSY: cleanup');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.failed, undefined);
  assert.deepEqual(result.changed, ['edited']);
  assert.match(logs.join('\n'), /committed; leftover cleanup is retried next start/);
  assert.match(readFileSync(join(dataDir, 'bots', 'edited', 'AGENT.md'), 'utf8'), /EDITED ON 1.3.0/);
  const [retired] = readBotMigration(dataDir).retired;
  assert.ok(existsSync(join(dataDir, 'bots', retired)), 'the replaced copy is still set aside');
  // The next start removes it and keeps the committed copy.
  assert.equal(run(dataDir).skipped, true);
  assert.deepEqual(readdirSync(join(dataDir, 'bots')).sort(), ['edited', 'migration.json']);
  assert.match(readFileSync(join(dataDir, 'bots', 'edited', 'AGENT.md'), 'utf8'), /EDITED ON 1.3.0/);
  assert.equal(readBotMigration(dataDir).retired, undefined);
});

test('10: a nested field changed on either side counts: a face edited on 1.3.0 syncs; connectors set on 1.3.1 are kept', (t) => {
  const dataDir = profile(t);
  writeAgent(dataDir, 'faced', { frontmatter: 'kind: bot\n', manifest: { avatar: MASCOT } });
  writeAgent(dataDir, 'wired', { frontmatter: 'kind: bot\n', manifest: { connectors: { off: ['gmail'] } } });
  run(dataDir);
  // 1.3.0 changes only a nested field of faced's face.
  editJson(join(dataDir, 'agents', 'faced', 'agent.json'), (value) => {
    value.avatar.color = '#ff0000';
  });
  // 1.3.1 changed wired's connectors in bots/, then 1.3.0 in agents/.
  editJson(join(dataDir, 'bots', 'wired', 'agent.json'), (value) => {
    value.connectors.off = ['gmail', 'slack'];
  });
  editJson(join(dataDir, 'agents', 'wired', 'agent.json'), (value) => {
    value.connectors.off = [];
  });
  const original = readFileSync(join(dataDir, 'agents', 'wired', 'agent.json'), 'utf8');
  const logs = [];
  const result = run(dataDir, { log: (line) => logs.push(line) });
  assert.deepEqual(result.changed, ['faced']);
  const bot = (id) => JSON.parse(readFileSync(join(dataDir, 'bots', id, 'agent.json'), 'utf8'));
  assert.equal(bot('faced').avatar.color, '#ff0000');
  assert.deepEqual(bot('wired').connectors.off, ['gmail', 'slack'], 'the bots/ edit is never overwritten');
  assert.match(logs.join('\n'), /wired: edited in both/);
  assert.equal(readFileSync(join(dataDir, 'agents', 'wired', 'agent.json'), 'utf8'), original, 'both edits kept');
});

test('11: 1.3.1 → 1.3.0 → 1.3.1: the 1.3.0 edit arrives once, backed up first; edits on both sides keep both', (t) => {
  const dataDir = profile(t);
  const backups = backupRoot(t);
  writeAgent(dataDir, 'pal', { frontmatter: 'kind: bot\n' });
  writeThread(dataDir, 'pal', chat);
  run(dataDir, { backup: splitBackup(dataDir) });
  // On 1.3.0 the user edits the bot (agents/ only).
  const persona = join(dataDir, 'agents', 'pal', 'PERSONA.md');
  writeFileSync(persona, 'From 1.3.0\n');
  later(persona);
  const agents = tree(join(dataDir, 'agents'));
  const sessions = tree(join(dataDir, 'sessions'));
  const result = run(dataDir, { backup: splitBackup(dataDir) });
  assert.deepEqual(result.changed, ['pal']);
  assert.equal(readFileSync(join(dataDir, 'bots', 'pal', 'PERSONA.md'), 'utf8'), 'From 1.3.0\n');
  assert.deepEqual(readdirSync(join(dataDir, 'bots')).sort(), ['migration.json', 'pal'], 'nothing duplicated');
  assert.deepEqual(tree(join(dataDir, 'agents')), agents, 'the user’s files untouched');
  assert.deepEqual(tree(join(dataDir, 'sessions')), sessions, 'every transcript byte-for-byte');
  // The copy it replaced is in the re-sync's backup.
  const copied = readdirSync(backups, { recursive: true }).map(String);
  assert.ok(copied.some((name) => /bot-split[\\/]bots[\\/]pal[\\/]AGENT\.md$/.test(name)));
  assert.equal(run(dataDir).skipped, true, 'and only once');
  // Edited on 1.3.1, then again on 1.3.0: neither edit is lost.
  writeFileSync(join(dataDir, 'bots', 'pal', 'PERSONA.md'), 'From 1.3.1\n');
  writeFileSync(persona, 'Again on 1.3.0\n');
  later(persona);
  assert.equal(run(dataDir, { log: () => {} }).skipped, true);
  assert.equal(readFileSync(join(dataDir, 'bots', 'pal', 'PERSONA.md'), 'utf8'), 'From 1.3.1\n');
  assert.equal(readFileSync(persona, 'utf8'), 'Again on 1.3.0\n');
});
