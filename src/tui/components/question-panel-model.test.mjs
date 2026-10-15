import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalShortcutDecision } from '../app/use-global-key-input/approval-shortcut.mjs';
import stringWidth from 'string-width';
import { answerFor, appendCapped, buildAnswers, initialCursor, optionLayout, planQuestionView, questionPanelRows } from './question-panel-model.mjs';

const questions = [
  { question: 'Auth?', header: 'Auth', options: [{ label: 'GitHub' }, { label: 'Email' }], recommended: 1 },
  { question: 'Features?', header: 'Feat', multi_select: true, options: [{ label: 'Dark' }, { label: 'Push' }, { label: 'Files' }] },
  { question: 'Deploy?', header: 'Deploy', options: [{ label: 'Vercel' }] },
  { question: 'Skipped?', header: 'Skip', options: [{ label: 'A' }] },
];

test('buildAnswers: single, multi, typed and unanswered', () => {
  const answers = buildAnswers(questions, [
    { selected: [0], text: '' },
    { selected: [2, 0], text: '' },
    { selected: [], text: '  local only ' },
    { selected: [], text: '' },
  ]);
  assert.deepEqual(answers, [
    { selected: ['GitHub'] },
    { selected: ['Dark', 'Files'] },
    { selected: [], text: 'local only' },
    null,
  ]);
});

test('answerFor: multi selection may carry typed text; missing draft is null', () => {
  assert.deepEqual(answerFor(questions[1], { selected: [1], text: 'more' }), { selected: ['Push'], text: 'more' });
  assert.equal(answerFor(questions[0], undefined), null);
  assert.equal(answerFor(questions[0], { selected: [9], text: '' }), null);
});

test('initialCursor follows the 0-based recommended index', () => {
  assert.equal(initialCursor(questions[0]), 1);
  assert.equal(initialCursor(questions[1]), 0);
});

test('optionLayout: the tradeoff follows the label on the same line, cut to fit', () => {
  const q = { question: 'Q?', header: 'h', recommended: 0, options: [{ label: 'Local', description: 'No setup, but this device only.' }, { label: 'Server', description: 'word '.repeat(40) }] };
  const wide = optionLayout(q, 80);
  assert.equal(wide.rows[0].detail, '  No setup, but this device only.');
  const cut = wide.rows[1];
  assert.ok(cut.detail.endsWith('…'));
  assert.ok(stringWidth(cut.label + cut.suffix + cut.detail) <= wide.avail - wide.prefixCells);
  // Too narrow for a useful tradeoff: the label alone.
  assert.equal(optionLayout(q, 22).rows[0].detail, '');
});

test('questionPanelRows: one row per option, descriptions never add rows', () => {
  const plain = [{ question: 'Q?', header: 'h', options: [{ label: 'A' }, { label: 'B' }] }];
  const described = [{ question: 'Q?', header: 'h', options: [{ label: 'A', description: 'word '.repeat(60) }, { label: 'B' }] }];
  assert.equal(questionPanelRows(described, 60), questionPanelRows(plain, 60));
});

test('planQuestionView fits 60x24 (20 panel rows) and keeps question + highlighted option', () => {
  const desc = '비밀번호 저장 없이 기존 계정으로 바로 로그인합니다. 기존 이메일 가입자는 다음 로그인 때 계정 연결을 안내합니다.';
  const q = {
    question: '로그인은 어떤 방식으로 구현할까요? 보안과 편의성의 균형을 고려해서 골라 주세요.',
    header: '인증',
    multi_select: true,
    options: Array.from({ length: 6 }, (_, i) => ({ label: `옵션 ${i + 1}`, description: desc })),
  };
  for (let cursor = 0; cursor <= 6; cursor++) {
    const plan = planQuestionView(q, 60, 20, cursor);
    const lines = plan.items.reduce((s, it) => s + it.lines, 0) + (plan.above ? 1 : 0) + (plan.below ? 1 : 0);
    assert.ok(5 + plan.qLines.length + lines <= 20, `cursor ${cursor} overflows`);
    assert.ok(plan.qLines.length >= 1);
    assert.ok(plan.items.some((it) => it.index === cursor), `cursor ${cursor} hidden`);
    assert.equal(plan.above + plan.below + plan.items.length, 7);
  }
  const unbudgeted = planQuestionView(q, 60, Infinity, 0);
  assert.equal(unbudgeted.items.length, 7);
  assert.equal(unbudgeted.above + unbudgeted.below, 0);
});

test('appendCapped never exceeds 4000 characters', () => {
  const a = appendCapped('', 'x'.repeat(3990));
  assert.equal(appendCapped(a, 'y'.repeat(50)).length, 4000);
  assert.equal(appendCapped('z'.repeat(4000), 'more'), 'z'.repeat(4000));
  // Emoji are two UTF-16 units: the cap matches the runtime's length check.
  const emoji = appendCapped('', '😀'.repeat(3000));
  assert.equal(emoji.length, 4000);
  assert.equal(appendCapped('z'.repeat(3999), '😀'), 'z'.repeat(3999), 'never half a character');
});

test('global approval shortcuts skip question approvals', () => {
  const question = { id: 'q', kind: 'question', name: 'ask_user', args: { questions } };
  for (const input of ['a', 'y', 'd', 'n', 'A']) assert.equal(approvalShortcutDecision(question, input, {}), null);
  assert.equal(approvalShortcutDecision(question, '', { escape: true }), null);
  const tool = { id: 't', name: 'read', args: {} };
  assert.deepEqual(approvalShortcutDecision(tool, 'y', {}), { approved: true, reason: 'approved by user' });
  assert.deepEqual(approvalShortcutDecision(tool, 'n', {}), { approved: false, reason: 'denied by user' });
  assert.equal(approvalShortcutDecision(tool, 'x', {})?.approved, undefined);
});
