import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { mountConversation } from './test-support/conversation-mount.mjs';

test('1: a send in flight for the outgoing session that fails stays with it, never joining or sending the picked draft', async (t) => {
  const pane = await mountConversation(t);
  const { show, input, type, press, host, submits, toasts } = pane;
  await show({ shown: 'sess_a1', selected: 'sess_a1' });
  let fail;
  host.submit = () => new Promise((_, reject) => (fail = reject));
  await type('for a');
  await press();
  assert.deepEqual(
    submits.map((entry) => [entry.to, entry.text]),
    [['sess_a1', 'for a']]
  );
  await show({ shown: 'sess_a1', selected: 'sess_b1' });
  await type('for b');
  await press();
  host.submit = async () => true;
  await act(async () => fail(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })));
  assert.equal(input().value, 'for b', 'the failed message does not join the picked draft');
  assert.deepEqual(toasts.filter((toast) => toast.tone === 'error'), [], 'nor is its failure reported there');
  await show({ shown: 'sess_b1', selected: 'sess_b1' });
  await act(async () => {});
  assert.deepEqual(
    submits.map((entry) => [entry.to, entry.text]),
    [
      ['sess_a1', 'for a'],
      ['sess_b1', 'for b'],
    ],
    'the landing sends what was typed for the picked session, and only that'
  );
  await show({ shown: 'sess_b1', selected: 'sess_a1' });
  assert.equal(input().value, 'for a', 'the failed message waits in its own session');
});

test('2: Stop and Escape while the lane is held stop nothing, and no stopped prompt lands in the picked draft', async (t) => {
  const pane = await mountConversation(t);
  const { document, show, input, type, press, key, click, aborts } = pane;
  const busy = { busy: true };
  await show({ shown: 'sess_a2', selected: 'sess_a2', lane: busy });
  assert.ok(document.querySelector('button.send-button.stop'), 'the outgoing session offers Stop while its turn runs');
  await show({ shown: 'sess_a2', selected: 'sess_b2', lane: busy });
  assert.equal(document.querySelector('button.send-button.stop'), null, 'the picked session has no turn to stop');
  await key('Escape');
  await key('Escape');
  await type('for b');
  await key('Escape');
  await click(document.querySelector('button.send-button'));
  await press();
  assert.deepEqual(aborts, [], 'the outgoing turn is not stopped');
  assert.equal(input().value, 'for b', 'and nothing of it reaches the picked draft');
});

test('3: a goal set from + while the lane is held starts on the picked session once it lands', async (t) => {
  const pane = await mountConversation(t);
  const { window, document, show, click, button, ran } = pane;
  await show({ shown: 'sess_a3', selected: 'sess_a3' });
  await show({ shown: 'sess_a3', selected: 'sess_b3' });
  await click(document.querySelector('button[aria-label="Add to message"]'));
  await click(button('Set a goal'));
  const objective = document.querySelector('.composer-goal-dialog textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(objective, 'ship it');
    objective.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    document
      .querySelector('.composer-goal-dialog form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(ran('goalControl', 'sess_a3'), [], 'the outgoing session gets no goal');
  assert.deepEqual(ran('goalControl', 'sess_b3'), [], 'the picked one gets it once its lane lands');
  await show({ shown: 'sess_b3', selected: 'sess_b3' });
  await act(async () => {});
  assert.deepEqual(
    ran('goalControl', 'sess_b3').map((request) => request.args),
    [[{ command: 'ship it --time 60m' }]]
  );
  assert.deepEqual(ran('goalControl', 'sess_a3'), []);
});

test('3: a goal started twice while the lane is held starts once when it lands, the dialog busy until it has', async (t) => {
  const pane = await mountConversation(t);
  const { window, document, show, click, button } = pane;
  // The goal that starts takes its time: the dialog is watched meanwhile.
  const invoke = window.mixdogDesktop.invokeCapability;
  const goals = [];
  let started;
  window.mixdogDesktop.invokeCapability = (request) => {
    if (request.capability !== 'goalControl') return invoke(request);
    goals.push(request);
    return new Promise((resolve) => (started = () => resolve(invoke(request))));
  };
  await show({ shown: 'sess_a3g', selected: 'sess_a3g' });
  await show({ shown: 'sess_a3g', selected: 'sess_b3g' });
  await click(document.querySelector('button[aria-label="Add to message"]'));
  await click(button('Set a goal'));
  const objective = document.querySelector('.composer-goal-dialog textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(objective, 'ship it');
    objective.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    for (let press = 0; press < 2; press += 1) {
      document
        .querySelector('.composer-goal-dialog form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    }
  });
  await show({ shown: 'sess_b3g', selected: 'sess_b3g' });
  await act(async () => {});
  assert.deepEqual(
    goals.map((request) => [request.sessionId, request.args]),
    [['sess_b3g', [{ command: 'ship it --time 60m' }]]],
    'one goal starts'
  );
  const dialog = () => document.querySelector('.composer-goal-dialog');
  assert.ok(!dialog().textContent.includes('could not be started'), 'the replaced start is no failure');
  assert.equal(dialog().querySelector('textarea').disabled, true, 'the dialog stays busy');
  await act(async () => started());
  assert.equal(dialog(), null, 'and closes once the goal has started');
  assert.equal(goals.length, 1);
});

test('4: room members, tags and agent mode are the picked session’s while the lane is held', async (t) => {
  const pane = await mountConversation(t);
  const { document, show, click, button } = pane;
  const { publishAgentRooms } = await import('./agent-room-store.ts');
  const room = (id, name, members) => ({
    id: `sess_room_${id}`,
    agentRoom: {
      id,
      name,
      members: Object.keys(members),
      memberNames: members,
      maxRounds: 3,
      maxMessages: 8,
      shareTools: false,
    },
  });
  publishAgentRooms([
    room('rooma4', 'Room A', { alpha: 'Alpha', beta: 'Beta' }),
    room('roomb4', 'Room B', { gamma: 'Gamma', delta: 'Delta' }),
  ]);
  t.after(() => publishAgentRooms([]));
  const chatMode = () => document.querySelector('form.composer').getAttribute('data-chat-mode');
  const members = async () => {
    await click(document.querySelector('button[aria-label="Add to message"]'));
    const call = button('Call a bot');
    if (call) await click(call);
    const names = [...document.querySelectorAll('.composer-add-menu .agent-room-ask-option')].map(
      (entry) => entry.lastElementChild.textContent
    );
    const goal = Boolean(button('Set a goal'));
    await click(document.querySelector('button[aria-label="Add to message"]'));
    return { names, goal };
  };

  await show({ shown: 'sess_room_rooma4', selected: 'sess_room_rooma4' });
  await show({ shown: 'sess_room_rooma4', selected: 'sess_room_roomb4' });
  assert.deepEqual(await members(), { names: ['Gamma', 'Delta'], goal: false }, 'Room A → Room B lists B’s members');

  await show({ shown: 'sess_room_roomb4', selected: 'sess_room_roomb4' });
  await show({ shown: 'sess_room_roomb4', selected: 'sess_plain4' });
  assert.equal(chatMode(), null, 'Room → Normal is a normal composer');
  assert.deepEqual(await members(), { names: [], goal: true }, 'with its goal and skills, and no members');

  await show({ shown: 'sess_plain4', selected: 'sess_plain4' });
  await show({ shown: 'sess_plain4', selected: 'sess_room_rooma4' });
  assert.equal(chatMode(), 'agent', 'Normal → Room is the room’s composer');
  assert.deepEqual(await members(), { names: ['Alpha', 'Beta'], goal: false }, 'listing the room’s own members');
});

test('5: the outgoing session’s visualize feedback stays with it while the lane is held', async (t) => {
  const pane = await mountConversation(t);
  const { document, show } = pane;
  const store = await import('./visualize-feedback-store.ts');
  t.after(() => store.resetVisualizeFeedback());
  const choice = {
    tabId: 'tab',
    tabLabel: 'Page',
    pane: 0,
    file: 'page.html',
    group: 'Layout',
    choice: 'a',
    label: 'Grid',
  };
  store.setVisualizeChoice('sess_a5', choice, true);
  const cards = () => document.querySelector('form.composer .visualize-feedback-cards');
  await show({ shown: 'sess_a5', selected: 'sess_a5' });
  assert.ok(cards(), 'the outgoing composer shows its feedback');
  await show({ shown: 'sess_a5', selected: 'sess_b5' });
  assert.equal(cards(), null, 'the picked composer shows none of it');
  await show({ shown: 'sess_b5', selected: 'sess_b5' });
  assert.equal(cards(), null);
  assert.equal(store.visualizeFeedbackFor('sess_a5').choices.length, 1, 'it waits with its session');
});

test('6: an edit or clear drops a send waiting for the lane', async (t) => {
  const pane = await mountConversation(t);
  const { show, input, type, press, key, ran, submits } = pane;
  await show({ shown: 'sess_a6', selected: 'sess_a6' });
  await show({ shown: 'sess_a6', selected: 'sess_b6' });
  await type('/compact');
  await press();
  await type('newer text');
  await show({ shown: 'sess_b6', selected: 'sess_b6' });
  await act(async () => {});
  assert.deepEqual(ran('compact', 'sess_b6'), [], 'an edited draft is not the command that waited');
  assert.equal(input().value, 'newer text', 'and the newer text stays');

  await show({ shown: 'sess_b6', selected: 'sess_c6' });
  await type('/compact');
  await press();
  // Escape closes the command list first, then clears on its second press.
  for (let presses = 0; presses < 3 && input().value; presses += 1) await key('Escape');
  assert.equal(input().value, '', 'cleared');
  await show({ shown: 'sess_c6', selected: 'sess_c6' });
  await act(async () => {});
  assert.deepEqual(ran('compact', 'sess_c6'), [], 'a cleared draft sends nothing');
  assert.deepEqual(submits, []);
});

test('7: double Escape while the lane is held neither lists nor rewinds the outgoing session’s prompts', async (t) => {
  const pane = await mountConversation(t);
  const { document, show, input, key, ran } = pane;
  const selector = () => document.querySelector('form.composer[data-composer-palette-open]');
  const listed = () => document.querySelector('.slash-palette')?.textContent ?? '';
  await show({ shown: 'sess_a7', selected: 'sess_a7' });
  await show({ shown: 'sess_a7', selected: 'sess_b7' });
  await key('Escape');
  await key('Escape');
  assert.equal(selector(), null, 'the outgoing prompts are not offered');
  assert.ok(!listed().includes('question sess_a7'));
  await key('Enter');
  assert.deepEqual(ran('rewindToItem', 'sess_a7'), [], 'nor rewound');
  assert.equal(input().value, '');
  await show({ shown: 'sess_b7', selected: 'sess_b7' });
  await key('Escape');
  await key('Escape');
  assert.ok(selector(), 'once landed, the picked session’s own prompts are');
  assert.ok(listed().includes('question sess_b7') && !listed().includes('question sess_a7'));
  await key('Enter');
  assert.deepEqual(
    ran('rewindToItem', 'sess_b7').map((request) => request.args),
    [['u-sess_b7']]
  );
  assert.deepEqual(ran('rewindToItem', 'sess_a7'), []);
  assert.equal(input().value, 'rewound sess_b7');
});

test('8: Send, slash commands, a failed send and a handed-back prompt each stay with their own session', async (t) => {
  const pane = await mountConversation(t);
  const { show, input, type, press, host, ran, submits, answers } = pane;
  const { nextComposerSubmissionId, stashedComposerDraft } = await import('./composer-draft.ts');
  const question = {
    toolApproval: {
      id: 'question-a8',
      kind: 'question',
      tool: 'ask_user',
      args: { questions: [{ question: 'Which one?', options: [{ label: 'This' }, { label: 'That' }] }] },
    },
  };
  await show({ shown: 'sess_a8', selected: 'sess_a8', lane: question });
  await show({ shown: 'sess_a8', selected: 'sess_b8', lane: question });
  await type('for b');
  await press();
  assert.deepEqual(answers, [], 'Send does not answer the outgoing session’s question');
  assert.deepEqual(submits, []);

  const id = nextComposerSubmissionId();
  const restore = { id: 'restore-a8', ids: [id], text: 'handed back to a', device: 'desktop', at: 1 };
  await show({ shown: 'sess_a8', selected: 'sess_b8', lane: { ...question, promptRestore: restore } });
  assert.equal(input().value, 'for b', 'a prompt handed back to the outgoing session does not join the picked draft');
  assert.ok(stashedComposerDraft('sess_a8').includes('handed back to a'), 'it waits in its own');

  host.submit = async () => {
    throw new Error('refused');
  };
  await show({ shown: 'sess_b8', selected: 'sess_b8' });
  await act(async () => {});
  assert.deepEqual(
    submits.map((entry) => [entry.to, entry.text]),
    [['sess_b8', 'for b']],
    'the waiting send runs on the picked session'
  );
  assert.deepEqual(answers, []);
  assert.equal(input().value, 'for b', 'and its failure comes back to the picked draft');

  host.submit = async () => true;
  await show({ shown: 'sess_b8', selected: 'sess_c8' });
  await type('/compact');
  await press();
  assert.deepEqual([...ran('compact', 'sess_b8'), ...ran('compact', 'sess_c8')], [], 'a slash command waits too');
  await show({ shown: 'sess_c8', selected: 'sess_c8' });
  await act(async () => {});
  assert.equal(ran('compact', 'sess_c8').length, 1, 'and runs on the picked session');
  assert.deepEqual(ran('compact', 'sess_b8'), []);
  await show({ shown: 'sess_c8', selected: 'sess_b8' });
  assert.equal(input().value, 'for b', 'the failed send stayed with its own session');
});

test('a message taken back from the outgoing transcript while the lane is held waits with its session', async (t) => {
  const pane = await mountConversation(t, { rows: true });
  const { document, show, frame, input, type, click, ran } = pane;
  const queued = {
    busy: true,
    turnId: 'turn-a10',
    queued: [{ id: 'queued-a10', text: 'queued for a', submittedAt: 1 }],
  };
  await show({ shown: 'sess_a10', selected: 'sess_a10', lane: queued });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  await show({ shown: 'sess_a10', selected: 'sess_b10', lane: queued });
  await type('for b');
  const cancel = document.querySelector('button.message-steer-cancel');
  assert.ok(cancel, 'the outgoing transcript still offers its queued message back');
  await click(cancel);
  assert.equal(ran('restoreQueued', 'sess_a10').length, 1, 'taken back from its own session');
  assert.equal(input().value, 'for b', 'not into the picked draft');
  await show({ shown: 'sess_b10', selected: 'sess_b10' });
  await show({ shown: 'sess_b10', selected: 'sess_a10' });
  assert.equal(input().value, 'queued for sess_a10', 'it waits in its own');
});

test('Retry on the outgoing transcript’s failed turn while the lane is held retries that session, not the picked one', async (t) => {
  const pane = await mountConversation(t, { rows: true });
  const { document, show, frame, input, type, click, submits, sessionSubmits } = pane;
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = [
    { kind: 'user', id: 'u-a11', text: 'question for a' },
    { kind: 'turndone', id: 'd-a11', status: 'failed', message: 'The model stopped.' },
  ];
  const failed = { items, failedTurnKeys: [transcriptTurnKeys(items)[0]] };
  await show({ shown: 'sess_a11', selected: 'sess_a11', lane: failed });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  await show({ shown: 'sess_a11', selected: 'sess_b11', lane: failed });
  await type('for b');
  const retry = [...document.querySelectorAll('.transcript-error-notice button')].find((entry) =>
    entry.textContent.includes('Retry')
  );
  assert.ok(retry, 'the outgoing transcript still offers its Retry');
  await click(retry);
  assert.deepEqual(submits, [], 'nothing goes to the picked session');
  assert.deepEqual(
    sessionSubmits.map((entry) => [entry.to, entry.text, entry.options.retryFailedTurn]),
    [['sess_a11', 'question for a', true]],
    'the failed turn is retried in its own session'
  );
  assert.equal(input().value, 'for b', 'and the picked draft is left alone');
});

test('a waiting send is dropped when the picked lane cannot be read, and the draft stays editable', async (t) => {
  const pane = await mountConversation(t);
  const { show, input, type, press, submits } = pane;
  await show({ shown: 'sess_a9', selected: 'sess_a9' });
  await show({ shown: 'sess_a9', selected: 'sess_b9' });
  await type('for b');
  await press();
  await show({ shown: 'sess_a9', selected: 'sess_b9', unavailable: true });
  await show({ shown: 'sess_a9', selected: 'sess_b9' });
  await show({ shown: 'sess_b9', selected: 'sess_b9' });
  await act(async () => {});
  assert.deepEqual(submits, [], 'nothing is sent when the lane is read again later');
  assert.equal(input().value, 'for b');
  await type('for b, again');
  await press();
  assert.deepEqual(
    submits.map((entry) => [entry.to, entry.text]),
    [['sess_b9', 'for b, again']]
  );
});
