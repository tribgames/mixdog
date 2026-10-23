// A bot's emoji reaction on the user's message: the fixed set, where it is
// stored, which message it lands on, who may leave one, and how a turn that
// only reacted ends.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REACTION_EMOJI,
  REACTION_TOOL_DEFS,
  isReactionSuccess,
  reactionCallIds,
  reactionEmoji,
  validateReactionArgs,
} from '../runtime-core/reaction-tool-defs.mjs';
import { featureDisallowedToolsFor } from '../runtime-core/builtin-features.mjs';
import { DEFERRED_DEFAULT_LEAD_TOOLS } from '../runtime-core/tool-catalog-data.mjs';
import { setInternalToolsProvider } from '../internal-tools.mjs';
import { createNoToolTurnResolver } from './loop/no-tool-turn.mjs';
import { runReactionTurn } from './message-reactions.test-support.mjs';
import { reactInSession, reactToMessage } from './message-reactions.mjs';
import { reactionDisabled, resolveSessionToolSurface } from './manager/session-tool-surface.mjs';
import { roomRowItem, roomRowMessage } from './agent-room.mjs';
import { restoreTranscriptItems } from './transcript-restore/restore.mjs';
import { createReactionToolHandlers } from '../../../../session-runtime/internal-tool-executor/reaction-tool.mjs';
import { createAgentRoomDelivery } from '../../../../session-runtime/agent-room-delivery.mjs';
import { isTranscriptHiddenControlToolName } from '../../../shared/tool-execution-contract.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const userMessage = (messageId, content = 'hello', extra = {}) => ({
  role: 'user',
  content,
  meta: { transcript: { at: 1, messageId, ...extra } },
});
const reply = (content) => ({ role: 'assistant', content });

test('only the seven reactions are accepted; a missing or extra U+FE0F is tolerated', () => {
  assert.deepEqual(REACTION_EMOJI, ['❤️', '👍', '✔️', '😆', '😮', '😢', '🙏']);
  for (const emoji of REACTION_EMOJI) assert.equal(reactionEmoji(emoji), emoji);
  assert.equal(reactionEmoji('❤'), '❤️', 'no variation selector');
  assert.equal(reactionEmoji('✔'), '✔️');
  assert.equal(reactionEmoji('👍\uFE0F'), '👍', 'an extra variation selector');
  assert.equal(reactionEmoji(' 🙏 '), '🙏');
  for (const bad of ['', 'ok', 'like', '👍👍', '❤️👍', '🔥', '👍🏻', ':+1:', null, 7]) {
    assert.equal(reactionEmoji(bad), '', String(bad));
    assert.throws(() => validateReactionArgs({ emoji: bad }), /exactly one of ❤️ 👍 ✔️ 😆 😮 😢 🙏/);
  }
  assert.throws(() => validateReactionArgs({}), /exactly one of/, 'setting needs an emoji');
  assert.deepEqual(validateReactionArgs({ emoji: '😮' }), { emoji: '😮', messagesBack: 0 });
  assert.deepEqual(validateReactionArgs({ remove: true }), { emoji: '', messagesBack: 0 });
  assert.deepEqual(validateReactionArgs({ emoji: '👍', messages_back: 2 }), { emoji: '👍', messagesBack: 2 });
  assert.throws(() => validateReactionArgs({ emoji: '👍', messages_back: -1 }), /messages_back/);
  assert.throws(() => validateReactionArgs({ emoji: '👍', messages_back: 1.5 }), /messages_back/);
});

test('the schema stays small; a react call shows no card; it sits on the Lead surface by default', () => {
  const [def] = REACTION_TOOL_DEFS;
  assert.equal(def.name, 'react');
  assert.deepEqual(Object.keys(def.inputSchema.properties), ['emoji', 'messages_back', 'remove']);
  assert.equal(def.inputSchema.additionalProperties, false);
  assert.ok(def.description.length < 900, def.description.length);
  assert.ok(DEFERRED_DEFAULT_LEAD_TOOLS.includes('react'));
  assert.equal(isTranscriptHiddenControlToolName('react'), true);
});

test('set, replace and remove: one reaction per bot, on the latest user message by default', () => {
  const messages = [userMessage('m1', 'first'), reply('ok'), userMessage('m2', 'second'), reply('sure')];
  const set = reactToMessage(messages, { agentId: 'reviewer', emoji: '👍', at: 5 });
  assert.equal(set.messageId, 'm2');
  assert.equal(set.changed, true);
  assert.notEqual(set.message, messages[2], 'a new object for the store to save');
  assert.deepEqual(set.message.meta.transcript.reactions, [{ agentId: 'reviewer', emoji: '👍', at: 5 }]);
  messages[2] = set.message;
  const replaced = reactToMessage(messages, { agentId: 'reviewer', emoji: '❤️', at: 6 });
  assert.deepEqual(replaced.reactions, [{ agentId: 'reviewer', emoji: '❤️', at: 6 }]);
  messages[2] = replaced.message;
  assert.equal(reactToMessage(messages, { agentId: 'reviewer', emoji: '❤️' }).changed, false);
  const removed = reactToMessage(messages, { agentId: 'reviewer', emoji: '' });
  assert.deepEqual(removed.reactions, []);
  assert.equal(Object.hasOwn(removed.message.meta.transcript, 'reactions'), false);
  assert.equal(removed.message.meta.transcript.messageId, 'm2', 'the rest of the metadata stays');
  messages[2] = removed.message;
  assert.equal(reactToMessage(messages, { agentId: 'reviewer', emoji: '' }).changed, false, 'nothing to remove');
  // messages_back reaches earlier user messages.
  assert.equal(reactToMessage(messages, { agentId: 'reviewer', emoji: '🙏', messagesBack: 1 }).messageId, 'm1');
  assert.throws(
    () => reactToMessage(messages, { agentId: 'reviewer', emoji: '🙏', messagesBack: 2 }),
    /only 2 user messages/
  );
  assert.throws(() => reactToMessage([reply('hi')], { agentId: 'reviewer', emoji: '🙏' }), /no user message/);
});

test("the target skips what the user did not write: runtime notices, posted results, other bots' messages, routine fires", () => {
  const messages = [
    userMessage('typed', 'mine'),
    userMessage('notice', '[mixdog-runtime] Empty response (1/3).'),
    { ...userMessage('posted', 'Routine ok'), meta: { source: 'routine-result', transcript: { messageId: 'posted' } } },
    userMessage('bot', 'from a bot', { fromAgent: 'other' }),
    userMessage('fire', 'run it', { routineTrigger: { kind: 'schedule', name: 'daily' } }),
    { ...userMessage('synthetic', 'done'), meta: { source: 'task-notification', transcript: { messageId: 'synthetic' } } },
    { role: 'user', content: 'no id' },
    userMessage('steered', 'and also this'),
  ];
  messages[7].meta.source = 'steering';
  assert.equal(reactToMessage(messages, { agentId: 'a', emoji: '👍' }).messageId, 'steered');
  assert.equal(reactToMessage(messages, { agentId: 'a', emoji: '👍', messagesBack: 1 }).messageId, 'typed');
});

test('a turn in flight: the working transcript and the session list both hold the reacted message', () => {
  const prompt = userMessage('now', 'great news!');
  const session = { id: 'sess_home_reviewer', messages: [reply('hi'), prompt] };
  session.liveTurnMessages = [...session.messages];
  const result = reactInSession(session, { agentId: 'reviewer', emoji: '😆' });
  assert.equal(session.liveTurnMessages[1], result.message);
  assert.equal(session.messages[1], result.message);
});

test('the react tool: a home chat stores and shows it; a room member reacts on the room log; others are refused', async () => {
  const shown = [];
  const live = () => ({ react: (...args) => shown.push(args) });
  const session = { id: 'sess_home_reviewer', messages: [userMessage('m1', '고마워')] };
  const rooms = [];
  const handlers = (rtSession) =>
    createReactionToolHandlers({
      rt: { session: rtSession },
      live,
      roomReact: async (id, change) => {
        rooms.push([id, change]);
        return { changed: true };
      },
    });
  const home = handlers(session);
  assert.match(await home.react({ emoji: '🙏' }, {}), /^Reacted 🙏\. .*Say nothing about it/);
  assert.deepEqual(session.messages[0].meta.transcript.reactions.map(({ agentId, emoji }) => ({ agentId, emoji })), [
    { agentId: 'reviewer', emoji: '🙏' },
  ]);
  assert.deepEqual(shown.map(([id, messageId, reactions]) => [id, messageId, reactions.length]), [
    ['sess_home_reviewer', 'm1', 1],
  ]);
  assert.equal(await home.react({ remove: true }, {}), 'Removed your reaction.');
  await assert.rejects(home.react({ emoji: 'nice' }, {}), /exactly one of/);

  const member = { id: 'sess_rmem_abc123_bench', messages: [] };
  await handlers(member).react({ emoji: '👍', messages_back: 1 }, {});
  assert.deepEqual(rooms, [['sess_room_abc123', { agentId: 'bench', emoji: '👍', messagesBack: 1 }]]);

  // A coding Lead, a delegated worker and a call for another session are refused.
  const refused = /reactions belong to a bot's own chat with the user/;
  await assert.rejects(handlers({ id: 'sess_daemon_x', messages: [] }).react({ emoji: '👍' }, {}), refused);
  await assert.rejects(
    handlers({ id: 'sess_home_reviewer', owner: 'agent', messages: [] }).react({ emoji: '👍' }, {}),
    refused
  );
  await assert.rejects(home.react({ emoji: '👍' }, { callerCtx: { callerSessionId: 'sess_home_other' } }), refused);
});

test('a room keeps each member’s reaction apart, refuses a repeat of another member’s emoji, and shows them live', async () => {
  const row = (id, extra = {}) => roomRowMessage({ id, kind: 'user', text: 'we shipped it', at: 10, ...extra });
  const log = {
    id: 'sess_room_abc123',
    messages: [row('u1'), roomRowMessage({ id: 's1', kind: 'speech', speaker: 'gh', name: 'GH', text: 'yay', at: 11 })],
  };
  const saves = [];
  const shown = [];
  const delivery = createAgentRoomDelivery({
    loadSession: () => log,
    saveSession: async (session) => saves.push(session.messages[0]),
    live: () => ({ react: (...args) => shown.push(args) }),
  });
  await delivery.react('sess_room_abc123', { agentId: 'gh', emoji: '❤️' });
  await delivery.react('sess_room_abc123', { agentId: 'bench', emoji: '👍' });
  await assert.rejects(delivery.react('sess_room_abc123', { agentId: 'rel', emoji: '👍' }), /bench already left 👍/);
  await delivery.react('sess_room_abc123', { agentId: 'gh', emoji: '😆' });
  const item = roomRowItem(log.messages[0], 'r');
  assert.equal(item.kind, 'user');
  assert.deepEqual(item.reactions.map(({ agentId, emoji }) => [agentId, emoji]), [
    ['gh', '😆'],
    ['bench', '👍'],
  ]);
  assert.equal(saves.length, 3, 'each change saved');
  assert.deepEqual(shown.map(([id, messageId]) => [id, messageId]), [
    ['sess_room_abc123', 'u1'],
    ['sess_room_abc123', 'u1'],
    ['sess_room_abc123', 'u1'],
  ]);
  await assert.rejects(delivery.react('sess_home_x', { agentId: 'gh', emoji: '👍' }), /not a group-room session/);
});

test("react is offered only in a bot's own chat with the user, and never while the setting is off", () => {
  assert.equal(reactionDisabled({ id: 'sess_home_reviewer' }, false), false);
  assert.equal(reactionDisabled({ id: 'sess_home_lead' }, false), false, "Mixy's home chat");
  assert.equal(reactionDisabled({ id: 'sess_rmem_abc123_bench' }, false), false);
  assert.equal(reactionDisabled({ id: 'sess_daemon_coding' }, false), true, 'a coding Lead');
  assert.equal(reactionDisabled({ id: 'sess_room_abc123' }, false), true, 'the room log runs no turn');
  assert.equal(reactionDisabled({ id: 'sess_home_reviewer' }, true), true, 'a delegated worker');
  assert.equal(reactionDisabled(null, false), true);
  assert.equal(featureDisallowedToolsFor({ reactions: false }).includes('react'), true);
  assert.equal(featureDisallowedToolsFor({}).includes('react'), false);

  const scopeId = 'reaction-gating-test';
  const dispose = setInternalToolsProvider({ scopeId, tools: [...REACTION_TOOL_DEFS], executor: async () => '' });
  try {
    const surface = (opts) =>
      resolveSessionToolSurface(
        { skipSkills: true, mcpScopeId: scopeId, owner: 'cli', ...opts },
        { profile: null, toolPreset: 'full', modelName: 'model' }
      ).tools.some((tool) => tool.name === 'react');
    assert.equal(surface({ id: 'sess_home_reviewer' }), true);
    assert.equal(surface({ id: 'sess_rmem_abc123_bench' }), true);
    assert.equal(surface({ id: 'sess_daemon_coding' }), false);
    assert.equal(surface({ id: 'sess_home_reviewer', owner: 'agent' }), false, 'a sub-agent');
    assert.equal(
      surface({ id: 'sess_home_reviewer', disallowedTools: featureDisallowedToolsFor({ reactions: false }) }),
      false,
      'setting off'
    );
  } finally {
    dispose();
  }
});

test('an empty reply after a reaction that landed ends the turn; without one it is nudged as before', async () => {
  const resolver = () =>
    createNoToolTurnResolver({ messages: [], opts: {}, sessionId: 's', sessionAgent: 'lead', drainSteering: () => false });
  const plain = resolver();
  assert.equal((await plain.resolve({ content: '' }, 1)).action, 'continue', 'nudged');

  const done = await runReactionTurn({ emoji: '👍' });
  assert.equal(done.results.at(-1).toolKind, 'normal', 'the real react result');
  assert.deepEqual(
    done.reactions.map(({ agentId, emoji }) => ({ agentId, emoji })),
    [{ agentId: 'reviewer', emoji: '👍' }]
  );
  assert.equal(done.sends, 2, 'no nudge round after the reaction');
  assert.equal(done.result.content, '');
});

test('reacting mid-turn leaves the provider prefix unchanged: the reply and the next turn go through', async () => {
  const run = await runReactionTurn({ emoji: '😮' }, { reply: 'Congratulations!', nextPrompt: 'thanks' });
  assert.equal(run.results.at(-1).toolKind, 'normal');
  assert.deepEqual(
    run.reactions.map(({ emoji }) => emoji),
    ['😮']
  );
  assert.equal(run.result.content, 'Congratulations!', 'the reply after the reaction is delivered');
  assert.equal(run.next.content, 'Next.', 'the next user turn passes the prefix guard');
  const quiet = await runReactionTurn({ emoji: '👍' }, { nextPrompt: 'ok' });
  assert.equal(quiet.result.content, '', 'a reaction-only turn still ends quietly');
  assert.equal(quiet.sends, 3);
});

test('a reaction is outside the provider prefix digest; other meta changes still count', async () => {
  const { prepareProviderPrefixGuard } = await import('./provider-prefix-guard.mjs');
  const prompt = userMessage('msg_p', 'hi');
  const before = prepareProviderPrefixGuard(null, [prompt], {}, {});
  const reacted = { ...prompt, meta: { transcript: { ...prompt.meta.transcript, reactions: [{ agentId: 'a', emoji: '👍', at: 2 }] } } };
  assert.doesNotThrow(() => prepareProviderPrefixGuard(before, [reacted], {}, {}));
  const rewritten = { ...prompt, content: 'hi!' };
  assert.throws(() => prepareProviderPrefixGuard(before, [rewritten], {}, {}), { code: 'PROVIDER_PREFIX_MUTATION' });
  const sourced = { ...prompt, meta: { ...prompt.meta, source: 'x' } };
  assert.throws(() => prepareProviderPrefixGuard(before, [sourced], {}, {}), { code: 'PROVIDER_PREFIX_MUTATION' });
});

test('a rejected or failed react call with an empty reply is an empty turn, nudged as before', async () => {
  for (const args of [{ emoji: 'hello' }, { emoji: '👍', messages_back: 5 }]) {
    const failed = await runReactionTurn(args);
    assert.equal(failed.results.at(-1).toolKind, 'error', JSON.stringify(args));
    assert.deepEqual(failed.reactions, []);
    assert.equal(failed.sends, 3, 'the empty reply was nudged');
    assert.equal(failed.result.content, 'Sure.');
  }
  // A call the schema allowlist denies never ran: not a reaction either.
  const resolver = createNoToolTurnResolver({
    messages: [],
    opts: {},
    sessionId: 's',
    sessionAgent: 'lead',
    drainSteering: () => false,
  });
  const call = { id: 'c', name: 'react', arguments: { emoji: '👍' } };
  resolver.noteToolCallTurn();
  resolver.noteToolBatchCompleted([call], [{ role: 'tool', toolCallId: 'c', toolKind: 'error', content: 'Error: no' }]);
  assert.equal((await resolver.resolve({ content: '' }, 2)).action, 'continue');
});

test('a react result counts only when it ran and succeeded; a bridged call is matched by its wire id', () => {
  const bridged = { id: 'w1', name: 'call_tool', arguments: { name: 'react', arguments: { emoji: '👍' } } };
  const ids = reactionCallIds([bridged, { id: 'r1', name: 'read', arguments: {} }]);
  assert.deepEqual([...ids], ['w1']);
  const result = (extra) => ({ role: 'tool', toolCallId: 'w1', content: 'r', ...extra });
  assert.equal(isReactionSuccess(result({ toolKind: 'normal' }), ids), true);
  for (const toolKind of ['error', 'skipped', undefined]) {
    assert.equal(isReactionSuccess(result({ toolKind }), ids), false, String(toolKind));
  }
  assert.equal(isReactionSuccess(result({ toolKind: 'normal', __earlyNotify: true }), ids), false);
  assert.equal(isReactionSuccess(result({ toolKind: 'normal', toolCallId: 'r1' }), ids), false);
});

test('a reaction survives a reload of the session from disk', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-reactions-'));
  const run = (source) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: { ...process.env, MIXDOG_DATA_DIR: dataDir, MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    run(`
      import { saveSession, drainSessionStore } from './src/runtime/agent/orchestrator/session/store.mjs';
      import { reactInSession } from './src/runtime/agent/orchestrator/session/message-reactions.mjs';
      const session = {
        id: 'sess_home_reviewer',
        owner: 'cli',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          { role: 'user', content: 'we shipped it', meta: { transcript: { at: 1, messageId: 'm1' } } },
          { role: 'assistant', content: '', emptyFinal: true },
        ],
      };
      saveSession(session, { sync: true });
      reactInSession(session, { agentId: 'reviewer', emoji: '😆', at: 2 });
      saveSession(session, { sync: true });
      drainSessionStore?.();
    `);
    const out = run(`
      import { loadSession } from './src/runtime/agent/orchestrator/session/store.mjs';
      import { restoreTranscriptItems } from './src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
      const items = restoreTranscriptItems(loadSession('sess_home_reviewer').messages, { sessionId: 'sess_home_reviewer' });
      console.log(JSON.stringify(items.map(({ kind, reactions }) => ({ kind, reactions }))));
    `);
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), [
      { kind: 'user', reactions: [{ agentId: 'reviewer', emoji: '😆', at: 2 }] },
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restored rows carry the reactions; a row without any carries none', () => {
  const messages = [
    userMessage('m1', 'hi', { reactions: [{ agentId: 'reviewer', emoji: '❤️', at: 1 }, { agentId: 'x y', emoji: '👍' }] }),
    userMessage('m2', 'again'),
  ];
  const [first, second] = restoreTranscriptItems(messages, { sessionId: 's' });
  assert.deepEqual(first.reactions, [{ agentId: 'reviewer', emoji: '❤️', at: 1 }], 'a malformed entry is dropped');
  assert.equal(Object.hasOwn(second, 'reactions'), false);
});
