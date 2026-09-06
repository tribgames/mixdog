import assert from 'node:assert/strict';
import test from 'node:test';
import { uiTranslationTemplates } from './auto-i18n-templates.ts';

test('count placeholders match numbers only; other placeholders still take free text', () => {
  const templates = uiTranslationTemplates(['{{count}} tasks', 'Rename {{value0}}', 'Plain label']);
  const tasks = templates.find((template) => template.key === '{{count}} tasks');
  assert.ok(tasks);
  assert.deepEqual(tasks.expression.exec('3 tasks')?.slice(1), ['3']);
  assert.deepEqual(tasks.expression.exec('1,204 tasks')?.slice(1), ['1,204']);
  // A sentence that merely ends in "tasks" is not a count template hit.
  assert.equal(tasks.expression.exec('Save authorization and stop active tasks'), null);
  const rename = templates.find((template) => template.key === 'Rename {{value0}}');
  assert.deepEqual(rename.expression.exec('Rename my notes.md')?.slice(1), ['my notes.md']);
  assert.equal(templates.some((template) => template.key === 'Plain label'), false);
});
