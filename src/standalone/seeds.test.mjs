import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retireSeededPackCopies, retireSeededSkillCopies } from './seeds.mjs';

function writeAt(file, content) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function writeSkill(dir, name, body, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${body}\n`);
  for (const [file, content] of Object.entries(extra)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
}

test('seeded copies identical to a bundled skill are retired; edited copies stay as overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-seeds-'));
  const rootDir = join(root, 'package');
  const dataDir = join(root, 'data');
  try {
    const bundled = join(rootDir, 'defaults', 'skills');
    const seeded = join(dataDir, 'skills');
    writeSkill(join(bundled, 'setup'), 'setup', 'Runbook', { 'references/a.md': 'a\n' });
    writeSkill(join(bundled, 'pptx'), 'pptx', 'Deck guide');
    writeSkill(join(bundled, 'docx'), 'docx', 'Document guide');

    // Untouched seed copied from a CRLF checkout: same tree, same text.
    writeSkill(join(seeded, 'setup'), 'setup', 'Runbook', { 'references/a.md': 'a\r\n' });
    writeFileSync(
      join(seeded, 'setup', 'SKILL.md'),
      `---\r\nname: setup\r\ndescription: Runbook\r\n---\r\n\r\n# Runbook\r\n`
    );
    // User edited the body: keep.
    writeSkill(join(seeded, 'pptx'), 'pptx', 'Deck guide with my notes');
    // User added a file next to an identical SKILL.md: keep.
    writeSkill(join(seeded, 'docx'), 'docx', 'Document guide', { 'references/mine.md': 'mine\n' });
    // Purely user-owned skill: never considered.
    writeSkill(join(seeded, 'mine'), 'mine', 'Personal');

    assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), ['setup']);
    assert.equal(existsSync(join(seeded, 'setup')), false);
    assert.equal(existsSync(join(seeded, 'pptx', 'SKILL.md')), true);
    assert.equal(existsSync(join(seeded, 'docx', 'references', 'mine.md')), true);
    assert.equal(existsSync(join(seeded, 'mine', 'SKILL.md')), true);
    assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no-op editor copies of shipped workflows/agents/styles are retired; edited ones stay', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-packs-'));
  const rootDir = join(root, 'package');
  const dataDir = join(root, 'data');
  try {
    writeAt(
      join(rootDir, 'workflows', 'default', 'WORKFLOW.md'),
      '---\nid: default\nname: Default\ndescription: "Handle tasks as requested."\n---\n\n# Default\n\nPlan first.\n'
    );
    writeAt(join(rootDir, 'workflows', 'solo', 'WORKFLOW.md'), '---\nid: solo\nname: Solo\n---\n\nWork alone.\n');
    writeAt(
      join(rootDir, 'agents', 'worker', 'AGENT.md'),
      '---\nname: Worker\ndescription: Implementation agent.\npermission: read-write\n---\n\nScoped implementation agent.\n'
    );
    writeAt(
      join(rootDir, 'agents', 'worker', 'agent.json'),
      '{\n  "id": "worker",\n  "name": "Worker",\n  "description": "Implementation agent.",\n  "entry": "AGENT.md"\n}\n'
    );
    writeAt(join(rootDir, 'agents', 'writer', 'AGENT.md'), '---\nname: Writer\n---\n\nWrites docs.\n');
    writeAt(join(rootDir, 'output-styles', 'simple.md'), '---\nname: simple\n---\n\n- Be brief.\n');
    writeAt(join(rootDir, 'output-styles', 'detailed.md'), '---\nname: detailed\n---\n\n- Explain.\n');

    // Saved from the editor without an edit: unquoted description, CRLF.
    writeAt(
      join(dataDir, 'workflows', 'default', 'WORKFLOW.md'),
      '---\r\nid: default\r\nname: Default\r\ndescription: Handle tasks as requested.\r\n---\r\n\r\n# Default\r\n\r\nPlan first.\r\n'
    );
    // Edited body: the user's override stays.
    writeAt(
      join(dataDir, 'workflows', 'solo', 'WORKFLOW.md'),
      '---\nid: solo\nname: Solo\n---\n\nWork alone, quietly.\n'
    );
    // No-op agent save: the editor drops `permission` and the manifest id/entry.
    writeAt(
      join(dataDir, 'agents', 'worker', 'AGENT.md'),
      '---\nname: Worker\ndescription: Implementation agent.\n---\n\nScoped implementation agent.\n'
    );
    writeAt(
      join(dataDir, 'agents', 'worker', 'agent.json'),
      '{\n  "name": "Worker",\n  "description": "Implementation agent."\n}\n'
    );
    // Tombstone for a deleted starter agent: never resurrected.
    writeAt(join(dataDir, 'agents', 'writer', '.deleted'), 'deleted\n');
    writeAt(join(dataDir, 'output-styles', 'simple.md'), '---\r\nname: simple\r\n---\r\n\r\n- Be brief.\r\n');
    writeAt(join(dataDir, 'output-styles', 'detailed.md'), '---\nname: detailed\n---\n\n- Explain a lot.\n');
    // Purely user-owned pack: never considered.
    writeAt(join(dataDir, 'workflows', 'mine', 'WORKFLOW.md'), '---\nid: mine\nname: Mine\n---\n\nMy flow.\n');

    assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), [
      'workflows/default',
      'agents/worker',
      'output-styles/simple.md',
    ]);
    assert.equal(existsSync(join(dataDir, 'workflows', 'default')), false);
    assert.equal(existsSync(join(dataDir, 'workflows', 'solo', 'WORKFLOW.md')), true);
    assert.equal(existsSync(join(dataDir, 'agents', 'worker')), false);
    assert.equal(existsSync(join(dataDir, 'agents', 'writer', '.deleted')), true);
    assert.equal(existsSync(join(dataDir, 'output-styles', 'simple.md')), false);
    assert.equal(existsSync(join(dataDir, 'output-styles', 'detailed.md')), true);
    assert.equal(existsSync(join(dataDir, 'workflows', 'mine', 'WORKFLOW.md')), true);
    assert.deepEqual(retireSeededPackCopies({ rootDir, dataDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
