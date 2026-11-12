// The cases of apps/desktop/src/main/session-final-answer.test.mjs (b6f10295a), as functions of the modules they drive (the recorder
// passes the Node tree's, the desktop's replay the product's). Each returns what the test asserted on, whole.
const assistant = (id, text) => ({ id, kind: 'assistant', text, streaming: false });
const done = (id, finalAssistantId, at = 2_000, status = 'done') => ({ id, kind: 'turndone', finalAssistantId, at, status });
const snapshot = (items, extra = {}) => ({ items, busy: false, ...extra });

export function finalAnswerScenarios({ isSessionMissingError, sessionFinalAnswer, SESSION_NOT_AVAILABLE_CODE, SessionHost, restoreTranscriptItems }) {
  const answerOf = (items, extra) => sessionFinalAnswer(snapshot(items, extra), 1_000);
  return {
    'a stored completed session restores the exact answer identity for notifications': async () => {
      const messages = [
        { role: 'user', content: 'Check this' },
        { role: 'assistant', content: 'Progress, not the final reply' },
        { role: 'assistant', content: 'Background answer', meta: { transcript: { at: 2_000, completion: { status: 'done', elapsedMs: 1_000 } } } },
      ];
      const restored = [];
      for (const itemLimit of [Infinity, 2]) restored.push({ itemLimit: String(itemLimit), answer: sessionFinalAnswer(snapshot(restoreTranscriptItems(messages, { sessionId: 'stored', itemLimit })), 1_000) });
      messages[2].meta.transcript.completion.status = 'failed';
      const items = restoreTranscriptItems(messages);
      return { restored, failed: sessionFinalAnswer(snapshot(items), 1_000), lastFinalAssistantId: items.at(-1).finalAssistantId ?? null };
    },
    'the completion identifies its final assistant, not user text, progress or tools': async () =>
      answerOf([
        { id: 'user', kind: 'user', text: 'First user prompt' },
        assistant('progress', 'I will check this.'),
        { id: 'tool', kind: 'tool', text: 'raw tool output' },
        assistant('final', 'This is the final answer.'),
        done('turn-1', 'final'),
      ]),
    'late, streaming, missing and older answers stay pending': async () => {
      const items = [assistant('old', 'Old answer'), done('old-turn', 'old', 500)];
      const complete = [assistant('final', 'Answer'), done('new-turn', 'final')];
      return [
        answerOf(items),
        answerOf([...items, done('new-turn', 'new')]),
        answerOf([...items, done('new-turn', 'old')]),
        answerOf([assistant('progress', 'Working'), done('new-turn', null)]),
        answerOf(complete, { busy: true }),
        answerOf(complete, { streamingTail: assistant('next', '...') }),
        answerOf([...complete, { id: 'next', kind: 'user', text: 'Next question' }]),
        answerOf([{ ...assistant('final', 'Partial'), streaming: true }, done('new-turn', 'final')]),
      ];
    },
    'the same wording is still a new answer when another turn produces it': async () =>
      answerOf([assistant('old', 'Done'), done('old-turn', 'old', 500), { id: 'user', kind: 'user', text: 'Again' }, assistant('new', 'Done'), done('new-turn', 'new')]),
    'a turn answered by a reaction alone is done with nothing to read; an unmarked empty turn stays pending': async () => {
      const user = { id: 'user', kind: 'user', text: '고마워' };
      const reacted = { id: 'turn', kind: 'turndone', at: 2_000, status: 'done', reacted: true };
      const { reacted: _reacted, ...plain } = reacted;
      return {
        reactionOnly: answerOf([user, reacted]),
        unmarked: answerOf([user, plain]),
        besideReply: answerOf([user, assistant('final', 'Congrats!'), { ...reacted, finalAssistantId: 'final' }]),
      };
    },
    'a stopped turn without a final reply is not announced as an answer': async () => answerOf([assistant('progress', 'Checking'), done('failed-turn', null, 2_000, 'failed')]),
    'the host reads the requested session without selecting it or publishing its state': async () => {
      const reads = [];
      const state = snapshot([assistant('final', 'Background session answer'), done('turn', 'final')]);
      const result = await SessionHost.prototype.readSessionFinalAnswer.call(
        {
          readSession: async (...args) => {
            reads.push(args);
            return state;
          },
        },
        'background-session',
        1_000,
      );
      return { reads, result };
    },
    'the host passes the abort signal to the session read and tags a missing session': async () => {
      const signal = new AbortController().signal;
      const reads = [];
      const missing = new Error('session gone-session is not available');
      const call = (readSession) => SessionHost.prototype.readSessionFinalAnswer.call({ readSession }, 'gone-session', 1_000, signal);
      const outcome = (promise) => promise.then(() => ({ rejected: false }), (error) => ({ rejected: true, same: error === missing, code: error.code ?? null, missingSession: isSessionMissingError(error) }));
      const missingOutcome = await outcome(call(async (...args) => {
        reads.push(args);
        throw missing;
      }));
      const otherOutcome = await outcome(call(async () => {
        throw new Error('disconnected');
      }));
      return { missingOutcome, codeIsNotAvailable: missingOutcome.code === SESSION_NOT_AVAILABLE_CODE, signalPassedToRead: reads[0][5] === signal, readArgsBeforeSignal: reads[0].slice(0, 5), otherOutcome };
    },
  };
}
