import assert from 'node:assert/strict';
import test from 'node:test';
import { ASK_USER_TOOL_DEFS, validateAskUserQuestions } from './ask-user-tool-defs.mjs';
import { collectStandaloneToolDefs } from './tool-defs.mjs';
import { DEFERRED_DEFAULT_FULL_TOOLS, DEFERRED_DEFAULT_LEAD_TOOLS, DEFERRED_DEFAULT_READONLY_TOOLS } from './tool-catalog-data.mjs';

const q = (over = {}) => ({ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], ...over });

test('ask_user def is deferred, hidden and compact', () => {
  const [def] = ASK_USER_TOOL_DEFS;
  assert.equal(def.name, 'ask_user');
  assert.ok(def.trigger);
  assert.equal(def.annotations.agentHidden, true);
  assert.equal(def.annotations.readOnlyHint, true);
  assert.equal(def.inputSchema.properties.questions.maxItems, 4);
  assert.ok(JSON.stringify(def).length < 4500);
  for (const list of [DEFERRED_DEFAULT_FULL_TOOLS, DEFERRED_DEFAULT_LEAD_TOOLS, DEFERRED_DEFAULT_READONLY_TOOLS]) {
    assert.ok(!list.includes('ask_user'));
  }
  const { standaloneTools } = collectStandaloneToolDefs({
    webSearchToolDefs: {},
    memoryToolDefs: {},
    codeGraphToolDefs: {},
    askUserToolDefs: ASK_USER_TOOL_DEFS,
  });
  assert.ok(standaloneTools.some((t) => t.name === 'ask_user'));
});

test('validation rejects duplicates and bad recommended', () => {
  assert.equal(validateAskUserQuestions({ questions: [q()] }).length, 1);
  assert.throws(() => validateAskUserQuestions({ questions: [q(), q()] }), /duplicates/);
  assert.throws(() => validateAskUserQuestions({ questions: [q({ options: [{ label: 'A' }, { label: 'A' }] })] }), /duplicate option/);
  assert.throws(() => validateAskUserQuestions({ questions: [q({ recommended: 2 })] }), /recommended/);
  assert.throws(() => validateAskUserQuestions({ questions: [] }), /1-4/);
});

test('options are label-only', () => {
  const described = q({ options: [{ label: 'A', description: 'why' }, { label: 'B' }] });
  assert.throws(() => validateAskUserQuestions({ questions: [described] }), /only a label/);
  const option = ASK_USER_TOOL_DEFS[0].inputSchema.properties.questions.items.properties.options.items;
  assert.deepEqual(Object.keys(option.properties), ['label']);
  assert.equal(option.additionalProperties, false);
});

test('worker tool list excludes ask_user, Lead keeps it', async () => {
  const { finalizeSessionToolList } = await import('../session/manager/tool-resolution.mjs');
  const tools = [{ name: 'read' }, { name: 'ask_user' }, { name: 'agent' }];
  assert.deepEqual(finalizeSessionToolList(tools, { ownerIsAgent: true }).map((t) => t.name), ['read']);
  assert.ok(finalizeSessionToolList(tools, { ownerIsAgent: false }).some((t) => t.name === 'ask_user'));
});

test('option labels over 80 chars are rejected and the schema states the limit', () => {
  const long = 'x'.repeat(81);
  assert.throws(() => validateAskUserQuestions({ questions: [q({ options: [{ label: long }, { label: 'B' }] })] }), /over 80/);
  validateAskUserQuestions({ questions: [q({ options: [{ label: 'x'.repeat(80) }, { label: 'B' }] })] });
  const label = ASK_USER_TOOL_DEFS[0].inputSchema.properties.questions.items.properties.options.items.properties.label;
  assert.equal(label.maxLength, 80);
  assert.throws(() => validateAskUserQuestions({ questions: [q({ header: 'x'.repeat(13) })] }), /12/);
});
