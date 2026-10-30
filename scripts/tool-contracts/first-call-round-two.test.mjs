import './_env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { TOOL_DEFS as browser } from '../../src/runtime/browser-bridge/tool-defs.mjs';
import { validateBrowserToolArgs } from '../../src/runtime/browser-bridge/action-schema.mjs';
import { COMPUTER_INPUT_SCHEMA, validateComputerToolArgs } from '../../src/runtime/computer-bridge/action-schema.mjs';
import { executeTodoTool, todoSnapshot } from '../../src/runtime/agent/orchestrator/runtime-core/todo-list.mjs';
import { MAX_TODO_ITEMS } from '../../src/runtime/agent/orchestrator/runtime-core/todo-tool-defs.mjs';
import { schemaStringLength, schemaValueError } from '../../src/runtime/shared/schema-value-error.mjs';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const browserSchema = browser.find((tool) => tool.name === 'browser').inputSchema;
const accepts = (schema, value) => assert.equal(ajv.validate(schema, value), true, JSON.stringify(ajv.errors));
const browserAccepts = (args) => {
  accepts(browserSchema, args);
  const result = validateBrowserToolArgs(args);
  assert.equal(result.ok, true, result.error);
};

test('computer action ordering is visible before composing a multi-action call', () => {
  const args = {
    action: 'act',
    input: {
      window_id: 'hwnd:0x1',
      actions: [
        { type: 'click', ref: 'ref:1' },
        { type: 'type', text: 'Value' },
        { type: 'key', keys: '{ENTER}' },
      ],
    },
  };
  accepts(COMPUTER_INPUT_SCHEMA, args);
  assert.equal(validateComputerToolArgs(args), null);
  args.input.actions[1] = { type: 'click', ref: 'ref:2' };
  assert.equal(validateComputerToolArgs(args), null);
  args.input.actions[1] = { type: 'move', ref: 'ref:2' };
  assert.match(
    validateComputerToolArgs(args),
    /after the first must be type, key, key_down, key_up, wait, or a ref-addressed/
  );
});

test('screenshot and select-sequence descriptions give the accepted first-call combinations', () => {
  for (const args of [
    { action: 'snapshot', input: { mode: 'visual', format: 'jpeg', quality: 80 } },
    { action: 'snapshot', input: { mode: 'visual', format: 'pdf' } },
    { action: 'select', input: { ref: 'p1-s1-e1' } },
    {
      action: 'sequence',
      input: {
        steps: [
          { action: 'click', ref: 'p1-s1-e1' },
          { action: 'select', ref: 'p1-s1-e2', values: ['KR'] },
        ],
      },
    },
  ])
    browserAccepts(args);
  assert.deepEqual(
    browser.find((tool) => tool.name === 'browser_devtools').inputSchema.properties.input.properties.format.enum,
    ['jpeg', 'png']
  );
  assert.equal(validateBrowserToolArgs({ action: 'snapshot', input: { mode: 'visual', quality: 80 } }).ok, false);
  assert.equal(validateBrowserToolArgs({ action: 'snapshot', input: { mode: 'both', format: 'pdf' } }).ok, false);
});

test('schema string bounds use Unicode code points, including minimum lengths', () => {
  assert.equal(schemaStringLength('a😀한'), 3);
  const schema = { type: 'string', minLength: 2, maxLength: 3 };
  for (const value of ['😀', '😀a', '😀a한', '😀a한b']) {
    assert.equal(schemaValueError(value, schema, 'text') === null, ajv.validate(schema, value));
  }
});

test('browser string guards agree with the schema on BMP and astral text', () => {
  for (const character of ['한', '😀']) {
    browserAccepts({ action: 'click', input: { target: { name: character.repeat(500) } } });
    browserAccepts({ action: 'snapshot', input: { query: character.repeat(4096) } });
    browserAccepts({ action: 'fill', input: { fields: [{ ref: 'p1-s1-e1', values: [character.repeat(4096)] }] } });
    browserAccepts({ action: 'click', input: { ref: 'p1-s1-e1', expect: { text: character.repeat(10000) } } });
    browserAccepts({ action: 'extract', input: { selector: 'a', attributes: [character.repeat(60)] } });
    browserAccepts({
      action: 'sequence',
      input: {
        steps: [
          { action: 'fill', savedAccount: character.repeat(320) },
          { action: 'press', key: 'Enter' },
        ],
      },
    });
    const tooLong = { action: 'click', input: { target: { name: character.repeat(501) } } };
    assert.equal(ajv.validate(browserSchema, tooLong), false);
    assert.equal(validateBrowserToolArgs(tooLong).ok, false);
  }
});

test('computer Unicode text respects schema bounds without increasing the native foreground budget', () => {
  const args = { action: 'verify', input: { window_id: 'hwnd:0x1', expect: [{ present: '😀'.repeat(4096) }] } };
  accepts(COMPUTER_INPUT_SCHEMA, args);
  assert.equal(validateComputerToolArgs(args), null);
  args.input.expect[0].present += '😀';
  assert.equal(ajv.validate(COMPUTER_INPUT_SCHEMA, args), false);
  assert.match(validateComputerToolArgs(args), /4096/);
  const type = {
    action: 'act',
    input: { window_id: 'hwnd:0x1', delivery: 'background', actions: [{ type: 'type', text: '😀'.repeat(30000) }] },
  };
  accepts(COMPUTER_INPUT_SCHEMA, type);
  assert.equal(validateComputerToolArgs(type), null);
  type.input.delivery = 'foreground';
  type.input.actions[0].text = '😀'.repeat(2000);
  assert.equal(validateComputerToolArgs(type), null);
  type.input.actions[0].text += '😀';
  assert.match(validateComputerToolArgs(type), /4000 UTF-16 code units/);
});

test('todo counts closed items toward its cap without weakening it', () => {
  const session = {};
  executeTodoTool(session, { op: 'init', items: Array.from({ length: MAX_TODO_ITEMS - 1 }, (_, i) => `Step ${i}`) });
  executeTodoTool(session, { op: 'done', item: 'Step 0' });
  executeTodoTool(session, { op: 'drop', item: 'Step 1' });
  assert.match(executeTodoTool(session, { op: 'append', items: ['New work'] }), /New work/);
  assert.throws(() => executeTodoTool(session, { op: 'append', items: ['Overflow'] }), /at most 50 items/);
  assert.equal(todoSnapshot(session).total, MAX_TODO_ITEMS);
});
