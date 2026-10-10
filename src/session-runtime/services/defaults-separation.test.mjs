import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  absorbSaveEqualToShipped,
  hashDefinition,
  hashText,
  hashTree,
  makeBackup,
  packDefinitionFrom,
} from '../../runtime/shared/shipped-definitions.mjs';
import { ensureStandaloneEnvironment, retireSeededPackCopies, retireSeededSkillCopies } from './seeds.mjs';
import { createWorkflowPacksApi } from '../workflow-agents-api/workflow-packs.mjs';

function writeAt(file, content) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-defsep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, rootDir: join(root, 'package'), dataDir: join(root, 'data') };
}

const agentMd = (body) => `---\nname: Worker\ndescription: Does work.\n---\n\n${body}\n`;
const agentDef = (body) => ({ name: 'Worker', description: 'Does work.', body });

function writeHistory(rootDir, history) {
  writeAt(join(rootDir, 'defaults', 'shipped-history.json'), JSON.stringify(history));
}

function backupFiles(dataDir) {
  const backups = join(dataDir, 'backups');
  if (!existsSync(backups)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  for (const run of readdirSync(backups)) {
    assert.match(run, /^defaults-separation-/);
    walk(join(backups, run), '');
  }
  return out.sort();
}

test('a copy equal to a historical shipped agent is retired into a backup; an edited one stays', (t) => {
  const { rootDir, dataDir } = setup(t);
  writeAt(join(rootDir, 'agents', 'worker', 'AGENT.md'), agentMd('Current text.'));
  writeAt(join(rootDir, 'agents', 'helper', 'AGENT.md'), agentMd('Current helper.'));
  writeHistory(rootDir, { agents: { worker: [hashDefinition(agentDef('Old text.'))] } });

  // Editor save of the old shipped text, CRLF and trailing spaces; plus a stray .bak.
  writeAt(join(dataDir, 'agents', 'worker', 'AGENT.md'), agentMd('Old text.   ').replace(/\n/g, '\r\n'));
  writeAt(join(dataDir, 'agents', 'worker', 'agent.json'), '{"name":"Worker","description":"Does work."}\n');
  writeAt(join(dataDir, 'agents', 'worker', 'AGENT.md.bak'), 'older backup\n');
  // Genuinely edited: not in history.
  writeAt(join(dataDir, 'agents', 'helper', 'AGENT.md'), agentMd('My own helper.'));

  assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), ['agents/worker']);
  assert.equal(existsSync(join(dataDir, 'agents', 'worker')), false);
  assert.equal(readFileSync(join(dataDir, 'agents', 'helper', 'AGENT.md'), 'utf8'), agentMd('My own helper.'));
  assert.deepEqual(backupFiles(dataDir), [
    '/agents/worker/AGENT.md',
    '/agents/worker/AGENT.md.bak',
    '/agents/worker/agent.json',
  ]);
  // Idempotent: nothing left to retire, no extra backup run.
  assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), []);
  assert.equal(readdirSync(join(dataDir, 'backups')).length, 1);
});

test('historical skill trees and output styles are retired; edits and user files keep', (t) => {
  const { rootDir, dataDir } = setup(t);
  const skill = (name, text) => [['SKILL.md', `---\nname: ${name}\ndescription: ${text}\n---\n\n${text}\n`]];
  writeAt(join(rootDir, 'defaults', 'skills', 'docx', 'SKILL.md'), skill('docx', 'New')[0][1]);
  writeAt(join(rootDir, 'defaults', 'skills', 'pdf', 'SKILL.md'), skill('pdf', 'New')[0][1]);
  writeAt(join(rootDir, 'output-styles', 'simple.md'), 'new style\n');
  writeHistory(rootDir, {
    skills: { docx: [hashTree(skill('docx', 'Old'))] },
    outputStyles: { 'simple.md': [hashText('old style\n')] },
  });
  writeAt(join(dataDir, 'skills', 'docx', 'SKILL.md'), skill('docx', 'Old')[0][1].replace(/\n/g, '\r\n'));
  writeAt(join(dataDir, 'skills', 'docx', 'SKILL.md.bak'), 'stray');
  writeAt(join(dataDir, 'skills', 'pdf', 'SKILL.md'), skill('pdf', 'Mine')[0][1]);
  writeAt(join(dataDir, 'output-styles', 'simple.md'), 'old style   \r\n');

  assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), ['docx']);
  assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), ['output-styles/simple.md']);
  assert.equal(existsSync(join(dataDir, 'skills', 'docx')), false);
  assert.equal(existsSync(join(dataDir, 'skills', 'pdf', 'SKILL.md')), true);
  assert.equal(existsSync(join(dataDir, 'output-styles', 'simple.md')), false);
  assert.equal(backupFiles(dataDir).length, 3);
  assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), []);
});

test('hashing ignores CRLF and trailing whitespace only', () => {
  assert.equal(hashText('a  \r\nb\r\n'), hashText('a\nb'));
  assert.notEqual(hashText('a\nb'), hashText('a\n b'));
  const read = (name) => (name === 'AGENT.md' ? agentMd('Body.') : null);
  assert.equal(hashDefinition(packDefinitionFrom(read, 'AGENT.md')), hashDefinition(agentDef('Body.')));
});

test('a metadata-only edit (permission, extra frontmatter, manifest key) keeps the copy', (t) => {
  const { rootDir, dataDir } = setup(t);
  const md = (extra) => `---\nname: Worker\ndescription: Does work.\n${extra}---\n\nSame body.\n`;
  for (const id of ['a', 'b', 'c', 'd']) {
    writeAt(join(rootDir, 'agents', id, 'AGENT.md'), md('permission: read-write\n'));
  }
  writeAt(join(dataDir, 'agents', 'a', 'AGENT.md'), md('permission: none\n'));
  writeAt(join(dataDir, 'agents', 'b', 'AGENT.md'), md(''));
  writeAt(join(dataDir, 'agents', 'c', 'AGENT.md'), md('permission: read-write\nhidden: true\n'));
  writeAt(join(dataDir, 'agents', 'd', 'AGENT.md'), md('permission: read-write\n'));
  writeAt(join(dataDir, 'agents', 'd', 'agent.json'), '{"model":"x"}');
  assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), []);
  // Identical metadata (CRLF, quoting) is still retired.
  writeAt(join(dataDir, 'agents', 'a', 'AGENT.md'), md('permission: "read-write"\n').replace(/\n/g, '\r\n'));
  assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), ['agents/a']);
});

test('a binary asset difference keeps a skill copy; text normalisation still applies', (t) => {
  const { rootDir, dataDir } = setup(t);
  const skillMd = '---\nname: s\ndescription: d\n---\n\nBody\n';
  writeAt(join(rootDir, 'defaults', 'skills', 's', 'SKILL.md'), skillMd);
  writeAt(join(rootDir, 'defaults', 'skills', 's', 'logo.bin'), Buffer.from([0, 13, 10, 1]));
  writeAt(join(dataDir, 'skills', 's', 'SKILL.md'), skillMd);
  writeAt(join(dataDir, 'skills', 's', 'logo.bin'), Buffer.from([0, 10, 1]));
  assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), []);
  writeAt(join(dataDir, 'skills', 's', 'logo.bin'), Buffer.from([0, 13, 10, 1]));
  assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), ['s']);
  assert.notEqual(hashTree([['a.bin', Buffer.from([0, 13, 10])]]), hashTree([['a.bin', Buffer.from([0, 10])]]));
  // No NUL byte, invalid UTF-8: still byte-exact.
  assert.notEqual(hashTree([['a.bin', Buffer.from([255, 13, 10])]]), hashTree([['a.bin', Buffer.from([254, 10])]]));
  assert.notEqual(hashTree([['a.bin', Buffer.from([255, 13, 10])]]), hashTree([['a.bin', Buffer.from([255, 10])]]));
  assert.equal(hashTree([['a.txt', Buffer.from('x\r\n')]]), hashTree([['a.txt', Buffer.from('x\n')]]));
});

test('historical retirement runs once per history version; current-version cleanup every start', (t) => {
  const { rootDir, dataDir } = setup(t);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  writeAt(join(rootDir, 'agents', 'worker', 'AGENT.md'), agentMd('Current text.'));
  writeHistory(rootDir, { agents: { worker: [hashDefinition(agentDef('Old text.'))] } });
  writeAt(join(dataDir, '.retired-channel-secrets-cleaned'), 'x');
  const oldCopy = () => writeAt(join(dataDir, 'agents', 'worker', 'AGENT.md'), agentMd('Old text.'));
  const exists = () => existsSync(join(dataDir, 'agents', 'worker'));

  oldCopy();
  ensureStandaloneEnvironment({ rootDir, dataDir });
  assert.equal(exists(), false);
  oldCopy();
  ensureStandaloneEnvironment({ rootDir, dataDir });
  assert.equal(exists(), true, 'historical copy untouched on later starts');
  writeAt(join(dataDir, 'agents', 'worker', 'AGENT.md'), agentMd('Current text.'));
  ensureStandaloneEnvironment({ rootDir, dataDir });
  assert.equal(exists(), false, 'current-version copy still retired every start');
  // A changed history re-arms the one-time sweep.
  writeHistory(rootDir, { agents: { worker: [hashDefinition(agentDef('Old text.')), hashDefinition(agentDef('Older.'))] } });
  writeAt(join(dataDir, 'agents', 'worker', 'AGENT.md'), agentMd('Older.'));
  ensureStandaloneEnvironment({ rootDir, dataDir });
  assert.equal(exists(), false);
});

test('backups never overwrite an existing backup path', (t) => {
  const { dataDir } = setup(t);
  const target = join(dataDir, 'agents', 'x');
  const stamp = (c) => writeAt(join(target, 'AGENT.md'), c);
  const first = makeBackup(dataDir);
  const second = makeBackup(dataDir);
  stamp('one');
  assert.equal(first.move(target), true);
  stamp('two');
  assert.equal(second.move(target), true);
  stamp('three');
  assert.equal(first.move(target), true); // same run, same relative path
  const contents = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else contents.push(readFileSync(join(dir, e.name), 'utf8'));
    }
  };
  walk(join(dataDir, 'backups'));
  assert.deepEqual(contents.sort(), ['one', 'three', 'two']);
});

test('an editor no-op save of a shipped agent with extra fields is absorbed', (t) => {
  const { rootDir, dataDir } = setup(t);
  writeAt(
    join(rootDir, 'agents', 'worker', 'AGENT.md'),
    '---\nname: Worker\ndescription: Does work.\npermission: read-write\n---\n\nBody.\n'
  );
  writeAt(join(rootDir, 'agents', 'worker', 'agent.json'), '{"id":"worker","name":"Worker","description":"Does work.","entry":"AGENT.md"}');
  const save = (definition) =>
    absorbSaveEqualToShipped({
      rootDir, dataDir, dir: 'agents', id: 'worker', entry: 'AGENT.md', files: ['AGENT.md', 'agent.json'], definition,
    });
  assert.equal(save({ name: 'Worker', description: 'Does work.', body: 'Body.' }), true);
  assert.equal(existsSync(join(dataDir, 'agents', 'worker')), false);
  assert.equal(save({ name: 'Worker', description: 'Does work.', body: 'Body changed.' }), false);
  // Tombstone only (shipped agent deleted): restoring the visible definition absorbs the tombstone.
  writeAt(join(dataDir, 'agents', 'worker', '.deleted'), '');
  assert.equal(save({ name: 'Worker', description: 'Does work.', body: 'Body.' }), true);
  assert.equal(existsSync(join(dataDir, 'agents', 'worker')), false);
  // A fieldless copy differs from the shipped fields: kept, shipped permission not restored.
  const fieldless = '---\nname: Worker\ndescription: Does work.\n---\n\nBody.\n';
  writeAt(join(dataDir, 'agents', 'worker', 'AGENT.md'), fieldless);
  assert.equal(save({ name: 'Worker', description: 'Does work.', body: 'Body.' }), false);
  assert.equal(readFileSync(join(dataDir, 'agents', 'worker', 'AGENT.md'), 'utf8'), fieldless);
  // A copy with identical fields is absorbed into a backup.
  writeAt(
    join(dataDir, 'agents', 'worker', 'AGENT.md'),
    '---\nname: Worker\ndescription: Does work.\npermission: read-write\n---\n\nEdited.\n'
  );
  assert.equal(save({ name: 'Worker', description: 'Does work.', body: 'Body.' }), true);
  assert.equal(existsSync(join(dataDir, 'agents', 'worker')), false);
  writeAt(
    join(dataDir, 'agents', 'worker', 'AGENT.md'),
    '---\nname: Worker\ndescription: Does work.\npermission: none\n---\n\nEdited.\n'
  );
  assert.equal(save({ name: 'Worker', description: 'Does work.', body: 'Body.' }), false);
  assert.equal(existsSync(join(dataDir, 'agents', 'worker', 'AGENT.md')), true);
});

test('saving a workflow equal to the shipped one leaves no user copy', async (t) => {
  const { rootDir, dataDir } = setup(t);
  writeAt(join(rootDir, 'workflows', 'flow', 'WORKFLOW.md'), '---\nid: flow\nname: Flow\n---\n\nDo it.\n');
  const api = createWorkflowPacksApi({
    rootDir,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    loadWorkflowPack: () => ({ id: 'flow', name: 'Flow', description: '', source: 'built-in', body: 'Do it.' }),
  });
  const copy = join(dataDir, 'workflows', 'flow');

  // An existing identical copy moves into the backup.
  writeAt(join(copy, 'WORKFLOW.md'), '---\nid: flow\nname: Flow\n---\n\nDo it.\n');
  await api.saveWorkflowPack({ id: 'flow', name: 'Flow', body: 'Do it.' });
  assert.equal(existsSync(copy), false);
  assert.deepEqual(backupFiles(dataDir), ['/workflows/flow/WORKFLOW.md']);

  // No copy is created by a no-op save; a real edit still writes one.
  await api.saveWorkflowPack({ id: 'flow', name: 'Flow', body: 'Do it.' });
  assert.equal(existsSync(copy), false);
  await api.saveWorkflowPack({ id: 'flow', name: 'Flow', body: 'Do it differently.' });
  assert.equal(existsSync(join(copy, 'WORKFLOW.md')), true);
});
