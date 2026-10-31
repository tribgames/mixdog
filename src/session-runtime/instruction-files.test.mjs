// The editable instruction texts (orchestration modes, output-style depth):
// shipped file, same-name user file replaces it, save / reset / modified, and
// the unedited prompt text matching its pinned shipped text.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInstructionFilesApi } from './workflow-agents-api/instruction-files.mjs';
import { _buildLeadMetaContext } from '../runtime/agent/orchestrator/session/manager/rules-cache.mjs';
import {
  orchestrationInstructions,
  readInstructionFile,
  userOrchestrationPath,
} from '../runtime/agent/orchestrator/runtime-core/orchestration.mjs';

// sha256 of orchestrationInstructions(mode) for the shipped text: byte-identical to
// the former hardcoded text except the concurrency line, which now names scopes
// running builds or tests (#291) in focused, balanced and swarm.
const FORMER = {
  none: '9be4bf61f9ba91c4caf53296adff2e8a787c3f71c4f4927315f4d1251f7c3a1a',
  focused: 'e73b0d71f544900611b2d06f963472d4f544227a74584689c510d294bac04960',
  balanced: 'ad1683ff1626ebabd4e027abe03fe29a82769d0c156d452847d96087598a0384',
  swarm: '7fa3e68e0c53d16203384f5ca645765dac68ada58b8d09818f01a0fe55dd453b',
};

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-instruction-files-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const api = createInstructionFilesApi({
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    rootDir: join(process.cwd(), 'src'),
    invalidateContextStatusCache() {},
  });
  return { dataDir, api };
}

test('unedited orchestration prompts match their pinned shipped text', (t) => {
  fixture(t);
  for (const [mode, hash] of Object.entries(FORMER)) {
    assert.equal(createHash('sha256').update(orchestrationInstructions(mode)).digest('hex'), hash, mode);
  }
});

test('a mode edit replaces the prompt text, shows modified, and reset restores the shipped text', async (t) => {
  const { dataDir, api } = fixture(t);
  const shipped = orchestrationInstructions('swarm');
  assert.equal(api.getInstructionFile('delegation', 'swarm').modified, false);
  const saved = await api.saveInstructionFile({
    group: 'delegation',
    id: 'swarm',
    body: '# Orchestration Mode: Swarm\n\nMine.',
  });
  assert.equal(saved.modified, true);
  assert.equal(saved.userOverride, true);
  assert.equal(orchestrationInstructions('swarm'), '# Orchestration Mode: Swarm\n\nMine.');
  assert.ok(existsSync(join(dataDir, 'orchestration', 'swarm.md')));
  const reset = await api.resetInstructionFile('delegation', 'swarm');
  assert.equal(reset.modified, false);
  assert.equal(orchestrationInstructions('swarm'), shipped);
  await assert.rejects(() => api.resetInstructionFile('delegation', 'swarm'), /no user override/);
});

test('saving the shipped text keeps no copy; a stale revision is refused; empty text is refused', async (t) => {
  const { dataDir, api } = fixture(t);
  const current = api.getInstructionFile('delegation', 'focused');
  await api.saveInstructionFile({ group: 'delegation', id: 'focused', body: current.defaultBody });
  assert.equal(existsSync(join(dataDir, 'orchestration', 'focused.md')), false);
  await api.saveInstructionFile({ group: 'delegation', id: 'focused', body: 'A' });
  await assert.rejects(
    () =>
      api.saveInstructionFile({ group: 'delegation', id: 'focused', body: 'B', expectedRevision: current.revision }),
    /INSTRUCTION_FILE_CONFLICT/
  );
  await assert.rejects(
    () => api.saveInstructionFile({ group: 'delegation', id: 'focused', body: '  ' }),
    /must not be empty/
  );
  await assert.rejects(() => api.saveInstructionFile({ group: 'delegation', id: 'nope', body: 'x' }), /must be one of/);
});

test('an empty, non-text or oversized user mode file falls back to the shipped text with a visible problem', (t) => {
  const { dataDir, api } = fixture(t);
  mkdirSync(join(dataDir, 'orchestration'));
  const file = join(dataDir, 'orchestration', 'balanced.md');
  const shipped = orchestrationInstructions('balanced');
  for (const [content, problem] of [
    ['  \n', 'empty'],
    [Buffer.from([0x61, 0xff, 0xfe]), 'not-text'],
    ['x'.repeat(256 * 1024 + 1), 'too-large'],
  ]) {
    writeFileSync(file, content);
    const state = api.getInstructionFile('delegation', 'balanced');
    assert.equal(state.problem, problem);
    assert.equal(state.modified, false);
    assert.equal(orchestrationInstructions('balanced'), shipped);
  }
});

test('an output-style edit writes the user file with the shipped front matter and the depth body only', async (t) => {
  const { dataDir, api } = fixture(t);
  const before = api.getInstructionFile('outputStyle', 'simple');
  assert.match(before.defaultBody, /^## Depth/);
  assert.doesNotMatch(before.defaultBody, /^---/);
  const saved = await api.saveInstructionFile({ group: 'outputStyle', id: 'simple', body: '## Depth\n\n- Mine.' });
  assert.equal(saved.modified, true);
  const raw = readFileSync(join(dataDir, 'output-styles', 'simple.md'), 'utf8');
  assert.match(raw, /^---\nname: simple\ntitle: Simple\n[\s\S]*?\n---\n\n## Depth\n\n- Mine\.\n$/);
  assert.equal((await api.resetInstructionFile('outputStyle', 'simple')).modified, false);
  assert.equal(existsSync(join(dataDir, 'output-styles', 'simple.md')), false);
});

test('an output-style user file with no body leaves the built-in style in the prompt', (t) => {
  const { dataDir, api } = fixture(t);
  mkdirSync(join(dataDir, 'output-styles'));
  writeFileSync(join(dataDir, 'output-styles', 'minimal.md'), '---\nname: minimal\n---\n');
  assert.equal(api.getInstructionFile('outputStyle', 'minimal').problem, 'empty');
  const meta = _buildLeadMetaContext({ config: { outputStyle: 'minimal' } });
  assert.match(meta, /# Output Style: Minimal/);
  assert.match(meta, /## Depth/);
});

test('a reset made against text the phone saved meanwhile is refused and deletes nothing', async (t) => {
  const { dataDir, api } = fixture(t);
  await api.saveInstructionFile({ group: 'delegation', id: 'swarm', body: 'First.' });
  const loaded = api.getInstructionFile('delegation', 'swarm');
  await api.saveInstructionFile({ group: 'delegation', id: 'swarm', body: 'Newer from the phone.' });
  await assert.rejects(
    () => api.resetInstructionFile('delegation', 'swarm', loaded.revision),
    /INSTRUCTION_FILE_CONFLICT/
  );
  assert.equal(readFileSync(join(dataDir, 'orchestration', 'swarm.md'), 'utf8'), 'Newer from the phone.\n');
  assert.ok(existsSync(join(dataDir, 'orchestration', 'swarm.md.bak')), 'the backup stays too');
  const current = api.getInstructionFile('delegation', 'swarm');
  assert.equal((await api.resetInstructionFile('delegation', 'swarm', current.revision)).modified, false);
});

test('a same-size edit with the same timestamp is never missed by the mode-file cache', (t) => {
  fixture(t);
  const file = userOrchestrationPath('focused');
  mkdirSync(join(file, '..'), { recursive: true });
  const stamp = new Date();
  writeFileSync(file, 'aaaa\n');
  utimesSync(file, stamp, stamp);
  assert.equal(readInstructionFile(file).text, 'aaaa');
  writeFileSync(file, 'bbbb\n');
  utimesSync(file, stamp, stamp);
  assert.equal(readInstructionFile(file).text, 'bbbb');
  assert.equal(orchestrationInstructions('focused'), 'bbbb');
});

test('an output-style user file that is not text is ignored by the prompt as the editor reports', (t) => {
  const { dataDir, api } = fixture(t);
  mkdirSync(join(dataDir, 'output-styles'));
  const shipped = api.getInstructionFile('outputStyle', 'minimal').defaultBody;
  for (const [bytes, problem] of [
    [Buffer.from('---\nname: minimal\n---\n\n## Depth\n\nbroken \0 text\n'), 'not-text'],
    [
      Buffer.concat([Buffer.from('---\nname: minimal\n---\n\n## Depth\n\n'), Buffer.from([0xff, 0xfe, 0x41])]),
      'not-text',
    ],
  ]) {
    writeFileSync(join(dataDir, 'output-styles', 'minimal.md'), bytes);
    assert.equal(api.getInstructionFile('outputStyle', 'minimal').problem, problem);
    const meta = _buildLeadMetaContext({ config: { outputStyle: 'minimal' } });
    assert.ok(meta.includes(shipped.split('\n').find((line) => line.startsWith('- '))), 'the built-in text is used');
    assert.ok(!meta.includes('broken'));
  }
});

test('a style file named for another style does not replace this one in the editor either', (t) => {
  const { dataDir, api } = fixture(t);
  mkdirSync(join(dataDir, 'output-styles'));
  writeFileSync(join(dataDir, 'output-styles', 'minimal.md'), '---\nname: other\n---\n\n## Depth\n\nx\n');
  const state = api.getInstructionFile('outputStyle', 'minimal');
  assert.equal(state.problem, 'invalid');
  assert.equal(state.modified, false);
});

test('a style body that fits only without its front matter is refused before anything is written', async (t) => {
  const { dataDir, api } = fixture(t);
  const body = 'x'.repeat(256 * 1024 - 8);
  await assert.rejects(
    () => api.saveInstructionFile({ group: 'outputStyle', id: 'simple', body }),
    /larger than 256 KB/
  );
  assert.equal(existsSync(join(dataDir, 'output-styles', 'simple.md')), false);
  assert.equal(api.getInstructionFile('outputStyle', 'simple').problem, undefined);
});
