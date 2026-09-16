import assert from 'node:assert/strict';
import test from 'node:test';

import { composeSystemPrompt, loadScopedRoleInstructions } from './collect.mjs';

test('response language closes the environment block, after every English session line', () => {
  const { sessionMarkerCore, sessionEnvironment, sessionMarker } = composeSystemPrompt({
    agentRules: '# Tool Workflow',
    workflowContext: '# Active Workflow: Solo',
    roleRules: '# General\n\n# Persona',
    coreMemoryContext: '- memo',
    languageContext: '# Language\n\n- Always respond in Korean.',
    sessionStartContext: '# Session\nCwd: C:\\p',
    environmentContext: '- Shell: PowerShell.\n- Git startup state: main',
    skipRoleCatalog: true,
  });
  assert.doesNotMatch(sessionMarkerCore, /# Language/);
  assert.ok(sessionEnvironment.trimEnd().endsWith('- Always respond in Korean.'));
  assert.ok(sessionEnvironment.indexOf('# Language') > sessionEnvironment.indexOf('Git startup state'));
  assert.ok(sessionMarker.trimEnd().endsWith('- Always respond in Korean.'));
});

test('composeSystemPrompt omits empty optional slices without rewriting present ones', () => {
  const { baseRules, stableSystemContext, sessionMarkerCore } = composeSystemPrompt({
    agentRules: '# Tool Workflow',
    metaContext: '  ',
    skillManifest: '# available-skills',
    deferredToolManifest: '',
    workflowContext: '# Active Workflow: Solo',
    roleRules: '',
    skipRoleCatalog: true,
  });
  assert.equal(baseRules, '# Tool Workflow');
  assert.equal(stableSystemContext, '# available-skills');
  assert.equal(sessionMarkerCore, '# Active Workflow: Solo');
});

test('public worker prompt includes that role catalog heading and omits other roles', () => {
  const { sessionMarkerCore } = composeSystemPrompt({
    agent: 'worker',
    workflowContext: '# Active Workflow: Solo',
  });
  assert.match(sessionMarkerCore, /^# Active Workflow: Solo\n\n---\n\n# Agent Role Catalog\n\n## worker\n/);
  assert.doesNotMatch(sessionMarkerCore, /## heavy-worker/);
  assert.doesNotMatch(sessionMarkerCore, /# Agent Role Rules/);
});

test('maintenance cycle1 prompt uses role rules without the public catalog', () => {
  const { sessionMarkerCore } = composeSystemPrompt({
    agent: 'cycle1-agent',
    workflowContext: '# Active Workflow: Solo',
  });
  assert.match(sessionMarkerCore, /^# Active Workflow: Solo\n\n---\n\n# Agent Role Rules\n\n## cycle1-agent\n/);
  assert.doesNotMatch(sessionMarkerCore, /# Agent Role Catalog/);
  assert.equal(
    loadScopedRoleInstructions('cycle1-agent'),
    sessionMarkerCore.slice('# Active Workflow: Solo\n\n---\n\n'.length)
  );
});
