import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreMemoryContext } from './core-memory-context.mjs';
import { writeCoreMemoryFileSnapshot } from '../../runtime/memory/lib/core-memory-file.mjs';

test('injection orders common, project, then the session’s own agent memory, byte-stable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-memory-block-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(join(project, '.mixdog'), { recursive: true });
  writeFileSync(join(project, '.mixdog', 'project.id'), 'agent-pool-alpha');
  const curated = [
    { id: 1, summary: 'Reviewer checks the changelog.', project_id: null, agent_id: 'reviewer' },
    { id: 1, summary: 'Alpha uses tabs.', project_id: 'agent-pool-alpha' },
    { id: 2, summary: 'Answer in Korean.', project_id: null },
    { id: 1, summary: 'Address the user politely.', project_id: null },
    { id: 1, summary: 'Writer drafts releases.', project_id: null, agent_id: 'writer' },
    { id: 1, summary: 'Beta uses spaces.', project_id: 'beta' },
  ];
  await writeCoreMemoryFileSnapshot(root, { curated }, { revision: 1 });
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
  });
  const block = (agentId) =>
    createCoreMemoryContext({
      getCurrentCwd: () => project,
      getMemoryAgentId: () => agentId,
      bootProfile: () => {},
      clean: (value) => String(value ?? '').trim(),
      cfgMod: {},
    }).loadCoreMemoryContext();
  const reviewer = await block('reviewer');
  assert.equal(
    reviewer,
    [
      '- Address the user politely.',
      '- Answer in Korean.',
      '- Alpha uses tabs.',
      '- Reviewer checks the changelog.',
    ].join('\n')
  );
  assert.equal(await block(''), '- Address the user politely.\n- Answer in Korean.\n- Alpha uses tabs.');
  assert.equal(await block('reviewer'), reviewer);

  // Another agent's pool changing leaves this block's bytes untouched.
  await writeCoreMemoryFileSnapshot(
    root,
    { curated: [...curated, { id: 2, summary: 'Writer prefers bullet lists.', agent_id: 'writer' }] },
    { revision: 2 }
  );
  assert.equal(Buffer.compare(Buffer.from(await block('reviewer')), Buffer.from(reviewer)), 0);

  assert.match(
    await block('writer'),
    /- Alpha uses tabs\.\n- Writer drafts releases\.\n- Writer prefers bullet lists\.$/
  );
});

const { formatCoreMemoryLines } = createCoreMemoryContext({
  clean: (value) => String(value ?? '').trim(),
});

test('core memory keeps every entry that fits the byte budget', () => {
  const userLines = Array.from({ length: 60 }, (_, index) => `rule ${index}`);
  const out = formatCoreMemoryLines({ userLines });
  assert.equal(out.split('\n').length, 60);
  assert.equal(out.endsWith('- rule 59'), true);
});

test('core memory over 32 KiB is cut on a character boundary with a marker', () => {
  const userLines = Array.from({ length: 40 }, (_, index) => `${index} ${'한글 지침 문장 '.repeat(120)}`);
  const out = formatCoreMemoryLines({ userLines });
  assert.equal(Buffer.byteLength(out, 'utf8') <= 32 * 1024, true);
  assert.equal(Buffer.byteLength(out, 'utf8') > 31 * 1024, true);
  assert.equal(out.endsWith('\n- ...'), true);
  assert.equal(out.includes('\uFFFD'), false);
});
