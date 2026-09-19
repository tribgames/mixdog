import assert from 'node:assert/strict';
import test from 'node:test';
import { withRuntimeUserContext, stripRuntimeUserContext } from '../runtime-user-context.mjs';
import { conversationCompactionInput, freshContextCompactMessages } from './runner.mjs';
import { runFreshContextCompact } from '../loop/fresh-context.mjs';
import { estimateMessagesTokens } from '../context-utils.mjs';
import { _sessionForDisk } from '../store/serialize.mjs';
import { prefixUserTurnContent, suffixUserTurnReminders } from '../manager/prompt-utils.mjs';

const literal = 'Keep this XML:\n```xml\n<system-reminder>USER_XML</system-reminder>\n```\n';
const suffix = '\n\n<system-reminder>\nOLD_RUNTIME_NOISE\n</system-reminder>';

function options(messages) {
  return {
    config: {},
    sessionRef: { id: 'compact-provenance-test', provider: 'test', model: 'test-model', contextWindow: 20_000 },
    messages,
    compactBudgetTokens: 5000,
    compactPolicy: { contextWindow: 20_000, reserveTokens: 0, tokenCalibration: 1 },
  };
}

test('producer-owned reminders preserve live media and follow the existing storage projection', () => {
  for (const content of [
    literal + suffix,
    [literal, { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }],
  ]) {
    const original = { role: 'user', content, meta: { transcript: { at: 1 } } };
    const wrapped = withRuntimeUserContext(original, { prefix: 'CURRENT_CONTEXT\n\n', suffix });
    assert.deepEqual(stripRuntimeUserContext(wrapped), original);
    const stored = JSON.parse(JSON.stringify(_sessionForDisk({ id: 'test', messages: [wrapped] })));
    const unwrappedStored = JSON.parse(JSON.stringify(_sessionForDisk({ id: 'test', messages: [original] })));
    assert.deepEqual(stripRuntimeUserContext(stored.messages[0]).content, unwrappedStored.messages[0].content);
    assert.deepEqual(original.content, content);
  }
});

test('unmarked or stale context is never removed by matching tag names', () => {
  const original = { role: 'user', content: literal + suffix };
  assert.equal(stripRuntimeUserContext(original), original);
  const wrapped = withRuntimeUserContext(original, { suffix });
  const changed = { ...wrapped, content: `${wrapped.content}edited after metadata was recorded` };
  assert.equal(stripRuntimeUserContext(changed), changed);
});

test('reminder ownership preserves the existing outgoing string and multimodal layouts', () => {
  for (const prompt of [literal, [{ type: 'text', text: literal }, 'second text block']]) {
    const base = prefixUserTurnContent(prompt, '# Additional context\nKeep this supplied context.\n\n');
    const reminder = '<system-reminder>\nCurrent runtime state\n</system-reminder>';
    const marked = withRuntimeUserContext(
      { role: 'user', content: base },
      { suffix: suffixUserTurnReminders('', reminder) }
    );
    assert.deepEqual(marked.content, suffixUserTurnReminders(base, reminder));
    assert.deepEqual(stripRuntimeUserContext(marked).content, base);
  }
});

test('rule-only retention and summary budgeting remove the same old owned noise, keeping the current request intact', async () => {
  const old = withRuntimeUserContext(
    { role: 'user', content: literal },
    { suffix: `\n\n<system-reminder>${'old runtime state '.repeat(10_000)}</system-reminder>` }
  );
  const latest = withRuntimeUserContext({ role: 'user', content: 'Continue.' }, { suffix });
  const messages = [
    { role: 'system', content: 'SYSTEM_RULES' },
    old,
    { role: 'assistant', content: 'Checked.' },
    latest,
  ];
  const before = structuredClone(messages);
  const result = await runFreshContextCompact(options(messages));
  assert.equal(result.handoffSource, 'rules');
  assert.equal(result.diagnostics.pipeline.summaryTriggered, false);
  assert.ok(result.diagnostics.finalTokens < 5000);
  assert.ok(result.messages.some((message) => message.content === literal));
  assert.deepEqual(result.messages.at(-1), latest);
  assert.equal(
    result.messages.some((message) => String(message.content).includes('old runtime state')),
    false
  );
  const input = conversationCompactionInput(messages);
  assert.equal(result.diagnostics.pipeline.conversationTokens, estimateMessagesTokens(input));
  assert.equal(
    input
      .map((message) => message.content)
      .join('\n')
      .includes('old runtime state'),
    false
  );
  assert.deepEqual(messages, before);
});

test('legacy unmarked envelopes remain counted and reach the summary instead of silently bypassing it', async () => {
  const legacy = `Old request.\n<system-reminder>${'unmarked source '.repeat(2000)}</system-reminder>`;
  const messages = [
    { role: 'user', content: legacy },
    { role: 'assistant', content: 'Checked.' },
    { role: 'user', content: 'Latest request.' },
  ];
  let captured = '';
  const result = await runFreshContextCompact({
    ...options(messages),
    provider: {
      name: 'test',
      async send(input) {
        captured += input[1].content;
        return { content: '## Goal\n- Continue the approved task.' };
      },
    },
  });
  assert.equal(result.diagnostics.pipeline.summaryTriggered, true);
  assert.ok(result.diagnostics.pipeline.conversationTokens >= 4000);
  assert.ok(captured.includes('unmarked source'));
  assert.equal(captured.includes('Latest request.'), false);
});

test('human XML and heading-shaped content survive summary projection in every text block', () => {
  const messages = [
    { role: 'user', content: `# Additional context\nHUMAN_DOCUMENT\n# Task\n${literal}` },
    { role: 'assistant', content: 'Example: <system-reminder>ASSISTANT_XML</system-reminder>' },
    { role: 'user', content: ['PLAIN_BLOCK', { type: 'text', text: literal }] },
    { role: 'user', content: 'Latest request.' },
  ];
  const text = conversationCompactionInput(messages)
    .map((message) => message.content)
    .join('\n');
  for (const marker of ['HUMAN_DOCUMENT', 'USER_XML', 'ASSISTANT_XML', 'PLAIN_BLOCK']) {
    assert.ok(text.includes(marker));
  }
});

test('Compact-owned Goal prefixes are removable on the next turn without removing quoted user Goal XML', () => {
  const human = 'Do not change this fixture:\n<system-reminder><goal_state>USER_GOAL</goal_state></system-reminder>';
  const currentGoal = '<system-reminder><goal_state>RUNTIME_GOAL</goal_state></system-reminder>';
  const messages = [
    { role: 'user', content: 'Old request.' },
    { role: 'assistant', content: 'Checked.' },
    withRuntimeUserContext({ role: 'user', content: human }, { suffix: `\n\n${currentGoal}` }),
  ];
  const result = freshContextCompactMessages(messages, 5000, {
    force: true,
    contextWindow: 20_000,
    latestUserPrefix: currentGoal,
  });
  const latest = result.messages.at(-1);
  assert.ok(latest.content.includes(human));
  assert.equal(latest.content.split('RUNTIME_GOAL').length - 1, 1);
  const next = [
    ...result.messages,
    { role: 'assistant', content: 'Checked again.' },
    { role: 'user', content: 'Next.' },
  ];
  const text = conversationCompactionInput(next)
    .map((message) => message.content)
    .join('\n');
  assert.ok(text.includes(human));
  assert.equal(text.includes('RUNTIME_GOAL'), false);
});
