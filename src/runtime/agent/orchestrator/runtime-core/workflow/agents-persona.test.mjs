import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readMarkdownDocument } from '../../../../shared/markdown-frontmatter.mjs';
import { clearAgentDefinitionCache } from '../workflow-ids.mjs';
import { createWorkflowAgents } from './agents.mjs';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'persona-agents-'));
  const rootDir = join(base, 'root');
  const dataDir = join(base, 'data');
  mkdirSync(join(dataDir, 'agents', 'poet'), { recursive: true });
  mkdirSync(join(dataDir, 'agents', 'plain'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'poet', 'AGENT.md'), 'Write poems.');
  writeFileSync(join(dataDir, 'agents', 'plain', 'AGENT.md'), 'Do work.');
  const agents = createWorkflowAgents({
    rootDir,
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone: (v) => v || 'none',
  });
  return { base, dataDir, agents };
}

test('PERSONA.md loads trimmed onto the definition; absent is empty', () => {
  const { base, dataDir, agents } = setup();
  try {
    writeFileSync(join(dataDir, 'agents', 'poet', 'PERSONA.md'), '\n  Warm and playful.  \n\n');
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').persona, 'Warm and playful.');
    assert.equal(agents.loadAgentDefinition(dataDir, 'plain').persona, '');
  } finally {
    clearAgentDefinitionCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a NUL-filled AGENT.md is no agent and a NUL-filled PERSONA.md is no persona', () => {
  const { base, dataDir, agents } = setup();
  try {
    writeFileSync(join(dataDir, 'agents', 'poet', 'AGENT.md'), '\0'.repeat(32));
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet'), null);
    writeFileSync(join(dataDir, 'agents', 'plain', 'PERSONA.md'), '\0'.repeat(32));
    const plain = agents.loadAgentDefinition(dataDir, 'plain');
    assert.equal(plain.body, 'Do work.');
    assert.equal(plain.persona, '');
  } finally {
    clearAgentDefinitionCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test('an edited PERSONA.md is picked up once the definition cache is cleared, like AGENT.md', () => {
  const { base, dataDir, agents } = setup();
  try {
    const file = join(dataDir, 'agents', 'poet', 'PERSONA.md');
    writeFileSync(file, 'Formal.');
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').persona, 'Formal.');
    writeFileSync(file, 'Casual.');
    clearAgentDefinitionCache('poet');
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').persona, 'Casual.');
  } finally {
    clearAgentDefinitionCache();
    rmSync(base, { recursive: true, force: true });
  }
});
