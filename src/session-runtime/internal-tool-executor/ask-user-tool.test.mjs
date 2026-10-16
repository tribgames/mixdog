import assert from 'node:assert/strict';
import test from 'node:test';
import { createAskUserToolHandlers } from './ask-user-tool.mjs';

const questions = [
  { question: 'Which db?', header: 'DB', options: [{ label: 'PG', description: 'p' }, { label: 'SQLite', description: 's' }] },
  {
    question: 'Which features?',
    header: 'Feat',
    multi_select: true,
    options: [
      { label: 'X', description: 'x' },
      { label: 'Y', description: 'y' },
    ],
  },
];
const { ask_user } = createAskUserToolHandlers({ rt: { session: { id: 's1' } } });
const run = (hook) => ask_user({ questions }, { callerCtx: { toolApprovalHook: hook, toolCallId: 'c1' } });

test('no hook', async () => {
  assert.match(await ask_user({ questions }, { callerCtx: {} }), /^No user is available/);
});

test('hook payload and answered / multi / typed / unanswered texts', async () => {
  let seen;
  const out = await run(async (req) => {
    seen = req;
    return { approved: true, answers: [{ selected: ['PG'] }, { selected: ['X', 'Y'] }] };
  });
  assert.equal(seen.kind, 'question');
  assert.equal(seen.timeoutMs, null, 'no wait limit');
  assert.equal(seen.sessionId, 's1');
  assert.equal(seen.toolCallId, 'c1');
  assert.equal(out, 'User has answered your questions: "Which db?"="PG"; "Which features?"="X, Y". You can now continue with these answers in mind.');
  const typed = await run(async () => ({ approved: true, answers: [{ selected: [], text: 'Mongo' }, null] }));
  assert.equal(typed, 'User has answered your questions: "Which db?"="Mongo" (typed); "Which features?"=(no answer). You can now continue with these answers in mind.');
  const both = await run(async () => ({
    approved: true,
    answers: [{ selected: ['PG'], text: 'say "hi", then' }, { selected: ['X'] }],
  }));
  assert.equal(
    both,
    'User has answered your questions: "Which db?"="PG" + "say \\"hi\\", then" (typed); "Which features?"="X". You can now continue with these answers in mind.'
  );
  const invalid = await run(async () => ({ approved: true, answers: [{ selected: ['Nope'] }] }));
  assert.match(invalid, /"Which db\?"=\(no answer\); "Which features\?"=\(no answer\)/);
});

test('dismissed', async () => {
  const dismissed = await run(async () => ({ approved: false, reason: 'denied by user' }));
  assert.match(dismissed, /^User closed the questions without answering\./);
});

const CLOSE = 'You can now continue with these answers in mind.';

test('chat reply: alone, with picks, quoted, bounded; absent reply unchanged', async () => {
  const only = await run(async () => ({ approved: true, answers: [], reply: '  use "Mongo" instead ' }));
  assert.equal(only, `User replied in chat: "use \\"Mongo\\" instead". ${CLOSE}`);
  const withPicks = await run(async () => ({
    approved: true,
    answers: [{ selected: ['PG'] }, null],
    reply: 'but keep it small',
  }));
  assert.equal(
    withPicks,
    `User replied in chat: "but keep it small". User has answered your questions: "Which db?"="PG"; "Which features?"=(no answer). ${CLOSE}`
  );
  const noReply = await run(async () => ({ approved: true, answers: [{ selected: ['PG'] }, null], reply: '   ' }));
  assert.equal(noReply, `User has answered your questions: "Which db?"="PG"; "Which features?"=(no answer). ${CLOSE}`);
  const tooLong = await run(async () => ({ approved: true, answers: [{ selected: ['PG'] }, null], reply: 'x'.repeat(4001) }));
  assert.doesNotMatch(tooLong, /replied in chat/);
  const max = await run(async () => ({ approved: true, reply: 'x'.repeat(4000) }));
  assert.match(max, /^User replied in chat: "x{4000}"\. /);
  const notString = await run(async () => ({ approved: true, reply: 7 }));
  assert.match(notString, /^User has answered your questions: "Which db\?"=\(no answer\)/);
  const dismissedWithReply = await run(async () => ({ approved: false, reply: 'hi' }));
  assert.match(dismissedWithReply, /^User closed the questions/);
});

test('aborting the turn settles a question the hook never answers', async () => {
  const controller = new AbortController();
  const pending = ask_user(
    { questions },
    { callerCtx: { toolApprovalHook: () => new Promise(() => {}), signal: controller.signal } }
  );
  controller.abort(new Error('turn aborted'));
  await assert.rejects(pending, /turn aborted/);
});

test('invalid questions are rejected', async () => {
  await assert.rejects(ask_user({ questions: [] }, { callerCtx: {} }), /1-4/);
});
