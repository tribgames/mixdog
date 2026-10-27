import assert from 'node:assert/strict';
import test from 'node:test';
import { ASK_USER_TOOL_DEFS, HANDOFF_USER_TOOL_DEFS, validateAskUserQuestions } from './ask-user-tool-defs.mjs';
import { HEADLESS_MODEL_TOOL_NAMES } from './tool-profile.mjs';
import { collectStandaloneToolDefs } from './tool-defs.mjs';
import {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
} from './tool-catalog-data.mjs';

const q = (over = {}) => ({
  question: 'Which?',
  header: 'Pick',
  options: [
    { label: 'A', description: 'a' },
    { label: 'B', description: 'b' },
  ],
  ...over,
});

test('ask_user is on the Lead surface only, hidden and compact', () => {
  const [def] = ASK_USER_TOOL_DEFS;
  assert.equal(def.name, 'ask_user');
  assert.ok(def.trigger);
  assert.equal(def.annotations.agentHidden, true);
  assert.equal(def.annotations.readOnlyHint, true);
  assert.equal(def.inputSchema.properties.questions.maxItems, 4);
  assert.deepEqual(Object.keys(def.inputSchema.properties), ['questions'], 'questions only; handoffs are handoff_user');
  assert.match(def.description, /handoff_user/);
  assert.ok(JSON.stringify(def).length < 3000);
  assert.ok(DEFERRED_DEFAULT_LEAD_TOOLS.includes('ask_user'));
  for (const list of [DEFERRED_DEFAULT_FULL_TOOLS, DEFERRED_DEFAULT_READONLY_TOOLS]) {
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

test('handoff_user is a deferred, Lead-only tool carrying the handoff rules', () => {
  const [def] = HANDOFF_USER_TOOL_DEFS;
  assert.equal(def.name, 'handoff_user');
  assert.ok(def.trigger);
  assert.equal(def.annotations.agentHidden, true);
  assert.equal(def.annotations.readOnlyHint, true);
  assert.match(
    def.description,
    /A step only the user can do on a page or app \(CAPTCHA, human check, sign-in, 2FA, a password\) is a handoff here, never a request in plain chat\./
  );
  const handoff = def.inputSchema.properties.handoff;
  assert.deepEqual(def.inputSchema.required, ['handoff']);
  assert.deepEqual(handoff.required, ['kind', 'surface']);
  assert.deepEqual(handoff.properties.kind.enum, ['secret', 'takeover']);
  assert.deepEqual(handoff.properties.surface.enum, ['browser', 'computer']);
  assert.match(handoff.description, /entered\/user_skipped\/no_field\/page_changed\/blocked\/expired/);
  assert.equal(handoff.properties.instructions.maxLength, 2000);
  // Deferred: never on the eager Lead, full or readonly defaults; headless sessions do not allow it.
  for (const list of [DEFERRED_DEFAULT_LEAD_TOOLS, DEFERRED_DEFAULT_FULL_TOOLS, DEFERRED_DEFAULT_READONLY_TOOLS]) {
    assert.ok(!list.includes('handoff_user'));
  }
  assert.ok(!HEADLESS_MODEL_TOOL_NAMES.includes('handoff_user'));
  const { standaloneTools } = collectStandaloneToolDefs({
    webSearchToolDefs: {},
    memoryToolDefs: {},
    codeGraphToolDefs: {},
    askUserToolDefs: ASK_USER_TOOL_DEFS,
    handoffUserToolDefs: HANDOFF_USER_TOOL_DEFS,
  });
  assert.ok(standaloneTools.some((t) => t.name === 'handoff_user'));
});

test('validation rejects duplicates and bad recommended', () => {
  assert.equal(validateAskUserQuestions({ questions: [q()] }).length, 1);
  assert.throws(() => validateAskUserQuestions({ questions: [q(), q()] }), /duplicates/);
  assert.throws(
    () =>
      validateAskUserQuestions({
        questions: [
          q({
            options: [
              { label: 'A', description: 'a' },
              { label: 'A', description: 'a' },
            ],
          }),
        ],
      }),
    /duplicate option/
  );
  assert.throws(() => validateAskUserQuestions({ questions: [q({ recommended: 2 })] }), /recommended/);
  assert.throws(() => validateAskUserQuestions({ questions: [] }), /1-4/);
});

test('options need a label and a one-sentence description', () => {
  const bare = q({ options: [{ label: 'A' }, { label: 'B', description: 'why' }] });
  assert.throws(() => validateAskUserQuestions({ questions: [bare] }), /needs a one-sentence description/);
  const extra = q({
    options: [
      { label: 'A', description: 'a', preview: 'x' },
      { label: 'B', description: 'b' },
    ],
  });
  assert.throws(() => validateAskUserQuestions({ questions: [extra] }), /only a label and a description/);
  const option = ASK_USER_TOOL_DEFS[0].inputSchema.properties.questions.items.properties.options.items;
  assert.deepEqual(option.required, ['label', 'description']);
  assert.equal(option.additionalProperties, false);
});

test('worker tool list excludes ask_user and handoff_user, Lead keeps them', async () => {
  const { finalizeSessionToolList } = await import('../session/manager/tool-resolution.mjs');
  const tools = [{ name: 'read' }, { name: 'ask_user' }, { name: 'handoff_user' }, { name: 'agent' }];
  assert.deepEqual(
    finalizeSessionToolList(tools, { ownerIsAgent: true }).map((t) => t.name),
    ['read']
  );
  const lead = finalizeSessionToolList(tools, { ownerIsAgent: false }).map((t) => t.name);
  assert.ok(lead.includes('ask_user') && lead.includes('handoff_user'));
});

test('option labels over 80 chars are rejected and the schema states the limit', () => {
  const long = 'x'.repeat(81);
  const option = (label) => ({ label, description: 'd' });
  assert.throws(
    () => validateAskUserQuestions({ questions: [q({ options: [option(long), option('B')] })] }),
    /over 80/
  );
  validateAskUserQuestions({ questions: [q({ options: [option('x'.repeat(80)), option('B')] })] });
  const label = ASK_USER_TOOL_DEFS[0].inputSchema.properties.questions.items.properties.options.items.properties.label;
  assert.equal(label.maxLength, 80);
  assert.throws(() => validateAskUserQuestions({ questions: [q({ header: 'x'.repeat(13) })] }), /12/);
});
