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

test('a direct edit of AGENT.md, agent.json or PERSONA.md is seen without clearing the cache', async () => {
  const { base, dataDir, agents } = setup();
  try {
    const dir = join(dataDir, 'agents', 'poet');
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').body, 'Write poems.');
    writeFileSync(join(dir, 'AGENT.md'), 'Write long poems now.');
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').body, 'Write long poems now.');
    writeFileSync(join(dir, 'PERSONA.md'), 'Warm.');
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').persona, 'Warm.');
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: 'Bard' }));
    assert.equal(agents.loadAgentDefinition(dataDir, 'poet').name, 'Bard');
    // A previously absent agent appearing on disk is found too.
    assert.equal(agents.loadAgentDefinition(dataDir, 'late'), null);
    mkdirSync(join(dataDir, 'agents', 'late'), { recursive: true });
    writeFileSync(join(dataDir, 'agents', 'late', 'AGENT.md'), 'Arrive late.');
    assert.equal(agents.loadAgentDefinition(dataDir, 'late').body, 'Arrive late.');
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
