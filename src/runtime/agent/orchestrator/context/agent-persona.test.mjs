import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sessionRolePromptFields } from '../session/manager/session-prompt-composition.mjs';
import { PERSONA_MAX_CHARS, PERSONA_TRUNCATION_MARKER, composeSystemPrompt } from './role-instructions.mjs';

function withDataDir(fn) {
  const base = mkdtempSync(join(tmpdir(), 'persona-prompt-'));
  const prevData = process.env.MIXDOG_DATA_DIR;
  const prevRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(base, 'data');
  process.env.MIXDOG_ROOT = join(base, 'root');
  const agent = (id, persona) => {
    const dir = join(base, 'data', 'agents', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENT.md'), `Role body of ${id}.`);
    if (persona !== undefined) writeFileSync(join(dir, 'PERSONA.md'), persona);
    return dir;
  };
  try {
    return fn({ base, agent });
  } finally {
    if (prevData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = prevData;
    if (prevRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = prevRoot;
    rmSync(base, { recursive: true, force: true });
  }
}

const compose = (agent, ownerIsAgent = false) =>
  composeSystemPrompt({
    ...sessionRolePromptFields(
      { agent, skipAgentRules: true },
      { ownerIsAgent, toolFreeRole: false, delegationFree: false }
    ),
  }).sessionMarkerCore;

test('persona follows the role section and is framed as a style guide', () => {
  withDataDir(({ agent }) => {
    agent('poet', 'Warm and playful.');
    const prompt = compose('poet');
    const role = prompt.indexOf('Role body of poet.');
    const persona = prompt.indexOf('## Persona');
    assert.ok(role >= 0 && persona > role);
    assert.match(prompt, /never overrides tool, safety or role rules/);
    assert.ok(prompt.indexOf('Warm and playful.') > persona);
    assert.equal(compose('poet'), prompt, 'stable across compositions');
  });
});

test('an agent without a persona gets no persona section', () => {
  withDataDir(({ agent }) => {
    agent('plain');
    assert.doesNotMatch(compose('plain'), /Persona/);
  });
});

test('an oversized persona is truncated with a marker', () => {
  withDataDir(({ agent }) => {
    agent('poet', 'x'.repeat(PERSONA_MAX_CHARS * 2));
    const prompt = compose('poet');
    assert.ok(prompt.includes(PERSONA_TRUNCATION_MARKER.trim()));
    assert.ok(!prompt.includes('x'.repeat(PERSONA_MAX_CHARS + 1)));
  });
});

test('an edited PERSONA.md applies to the next composition', () => {
  withDataDir(({ agent }) => {
    const dir = agent('poet', 'Formal tone.');
    assert.match(compose('poet'), /Formal tone\./);
    writeFileSync(join(dir, 'PERSONA.md'), 'Casual tone.');
    const next = compose('poet');
    assert.match(next, /Casual tone\./);
    assert.doesNotMatch(next, /Formal tone\./);
  });
});

test("Mixy's persona (agents/lead) rides only Mixy's own agent-mode thread, never a coding Lead", () => {
  withDataDir(({ base }) => {
    const before = compose('lead');
    assert.doesNotMatch(before, /Persona/);
    assert.equal(compose(null), before);
    const dir = join(base, 'data', 'agents', 'lead');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PERSONA.md'), 'Calm and concise.');
    // A coding Lead (the `lead` role, outside Mixy's thread) is unchanged.
    assert.equal(compose('lead'), before);
    assert.equal(compose(null), before);
    const mixy = composeSystemPrompt({
      ...sessionRolePromptFields(
        { agent: 'lead' },
        { ownerIsAgent: false, toolFreeRole: false, delegationFree: false, sessionMode: 'agent' }
      ),
    }).sessionMarkerCore;
    assert.match(mixy, /## Persona[\s\S]*Calm and concise\./);
  });
});
