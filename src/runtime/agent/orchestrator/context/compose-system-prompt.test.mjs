import assert from 'node:assert/strict';
import test from 'node:test';

import { composeSystemPrompt } from './collect.mjs';

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
