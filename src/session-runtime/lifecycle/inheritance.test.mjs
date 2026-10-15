import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The store resolves MIXDOG_DATA_DIR at write time and defers its writes, so
// the temp root stays pinned for the whole process.
const root = mkdtempSync(join(tmpdir(), 'mixdog-inherit-new-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession } = await import('../../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
const { deleteSession, loadSession, listStoredSessionSummaries } = await import(
  '../../runtime/agent/orchestrator/session/store.mjs'
);
const { _withRegisteredProviderForTestAsync } = await import('../../runtime/agent/orchestrator/providers/registry.mjs');
const { createLifecycleApi } = await import('../lifecycle-api.mjs');
const { listLeadSessions } = await import('./session-catalog.mjs');
const { inheritanceFitMessage } = await import('../inheritance-fit.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const providerName = 'inherit-new-session-test';
const provider = {
  name: providerName,
  contextWindow: 128000,
  async send() {
    throw new Error('no turn runs during inheritance');
  },
};
const desktopSession = { classification: 'project', projectPath: root };

function openLive(conversation) {
  const session = createSession({
    provider: providerName,
    model: 'fake-model',
    owner: 'cli',
    agent: 'lead',
    lane: 'cli',
    sourceType: 'lead',
    sourceName: 'main',
    cwd: root,
    desktopSession,
    skipSkills: true,
  });
  session.messages.push(...conversation);
  session.title = 'Source title';
  return session;
}

function lifecycleFor(live, compactConversation = null) {
  return createLifecycleApi({
    getSession: () => live,
    getRoute: () => ({ provider: providerName, model: 'fake-model' }),
    mgr: { getSession: (id) => loadSession(id) },
    invalidateContextStatusCache() {},
    saveSession() {},
    ...(compactConversation ? { compactConversation } : {}),
  });
}

const conversationOf = (session) =>
  session.messages.filter((message) => message.role !== 'system').map((message) => [message.role, message.content]);
const systemCount = (session) => session.messages.filter((message) => message.role === 'system').length;

const CONVERSATION = [
  { role: 'user', content: 'Plan the migration.' },
  { role: 'assistant', content: 'Here is the plan.' },
];

test('inheritToNewSession persists a cold resumable heir and leaves the live session current and untouched', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const live = openLive(CONVERSATION);
    // Mid-turn: the in-flight prompt is pre-committed to `messages` while the
    // turn's working transcript grows in `liveTurnMessages`.
    const inFlight = { role: 'user', content: 'Carry this into a new session.' };
    live.messages.push(inFlight);
    live.liveTurnMessages = [...live.messages, { role: 'assistant', content: '', toolCalls: [{ id: 't1' }] }];
    const before = JSON.stringify({ ...live, liveTurnMessages: null });
    const liveTurn = live.liveTurnMessages;
    const api = lifecycleFor(live);
    let heirId = null;
    try {
      const result = await api.inheritToNewSession(live.id);
      heirId = result.sessionId;
      assert.notEqual(result.sessionId, live.id);
      assert.deepEqual({ messages: result.messages, compacted: result.compacted }, { messages: 2, compacted: false });

      // The live session is still the one in use and was not mutated.
      assert.equal(lifecycleFor(live).inheritancePreflight().sourceSessionId, live.id);
      assert.equal(JSON.stringify({ ...live, liveTurnMessages: null }), before);
      assert.equal(live.liveTurnMessages, liveTurn);

      // Persisted on disk: same route, cwd and Project; system layer then the
      // committed conversation only (the in-flight prompt does not travel).
      const stored = loadSession(heirId);
      assert.equal(stored.provider, live.provider);
      assert.equal(stored.model, live.model);
      assert.equal(stored.cwd, live.cwd);
      assert.deepEqual(stored.desktopSession, live.desktopSession);
      assert.equal(stored.inheritedFromSessionId, live.id);
      assert.equal(stored.title, 'Source title');
      assert.equal(stored.closed, false);
      assert.equal(stored.liveTurnMessages, undefined);
      assert.equal(stored.activeTurnCheckpoint, undefined);
      assert.equal(systemCount(stored), systemCount(live));
      assert.deepEqual(conversationOf(stored), [
        ['user', 'Plan the migration.'],
        ['assistant', 'Here is the plan.'],
      ]);
      assert.deepEqual(
        stored.messages.at(-1).meta.sessionInheritances.map(({ sourceSessionId, sessionId }) => [
          sourceSessionId,
          sessionId,
        ]),
        [[live.id, heirId]]
      );

      // Listed like any other saved Lead session.
      const summaries = listStoredSessionSummaries({ refreshFromStorage: true });
      const row = listLeadSessions({ listSessions: () => summaries }).find((entry) => entry.id === heirId);
      assert.ok(row);
      assert.equal(row.inheritedFromSessionId, live.id);
      assert.equal(row.messageCount, 2);
    } finally {
      if (heirId) deleteSession(heirId);
      deleteSession(live.id);
    }
  });
});

test('inheritToNewSession titleSuffix marks the heir title as a locked model title', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const live = openLive(CONVERSATION);
    let heirId = null;
    try {
      heirId = (await lifecycleFor(live).inheritToNewSession(live.id, { titleSuffix: ' (Fork)' })).sessionId;
      const stored = loadSession(heirId);
      assert.equal(stored.title, 'Source title (Fork)');
      assert.equal(stored.titleLocked, true);
      assert.equal(stored.titleSource, 'ai');
      assert.equal(live.title, 'Source title');
    } finally {
      if (heirId) deleteSession(heirId);
      deleteSession(live.id);
    }
  });
});

test('a recovered root Lead (agent owner, self-links, agent-only marker) yields a user-visible root Lead heir', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const live = openLive(CONVERSATION);
    // Recovery left Agent ownership, self owner/parent links and stale
    // child-session markers on a root Lead; it is still an ordinary session.
    Object.assign(live, {
      owner: 'agent',
      ownerSessionId: live.id,
      parentSessionId: live.id,
      visibility: 'agent-only',
      sessionVisibility: 'agent-only',
      agentTag: 'worker3',
      taskType: 'recovered',
      task_id: 'task-1',
      scopeKey: 'scope-of-source',
      permissionMode: 'restricted',
      sourceType: 'agent',
      sourceName: 'worker',
      lane: 'agent',
      contextPressureUnanchoredAfterRestart: true,
      contextPressureUnanchoredReason: 'mid_turn_snapshot',
    });
    const api = lifecycleFor(live);
    let heirId = null;
    try {
      // Precondition: the source itself is in the user's catalog.
      assert.deepEqual(
        listLeadSessions({ listSessions: () => [live] }).map((row) => row.id),
        [live.id]
      );

      heirId = (await api.inheritToNewSession(live.id)).sessionId;
      const stored = loadSession(heirId);
      assert.deepEqual(
        {
          owner: stored.owner,
          agent: stored.agent,
          lane: stored.lane,
          sourceType: stored.sourceType,
          sourceName: stored.sourceName,
          parentSessionId: stored.parentSessionId,
          ownerSessionId: stored.ownerSessionId,
          visibility: stored.visibility,
          agentTag: stored.agentTag,
          taskType: stored.taskType,
          scopeKey: stored.scopeKey,
          permissionMode: stored.permissionMode,
        },
        {
          owner: 'cli',
          agent: 'lead',
          lane: 'cli',
          sourceType: 'lead',
          sourceName: 'main',
          parentSessionId: null,
          ownerSessionId: null,
          visibility: null,
          agentTag: null,
          taskType: null,
          scopeKey: null,
          permissionMode: null,
        }
      );
      for (const key of ['sessionVisibility', 'task_id', 'contextPressureUnanchoredAfterRestart']) {
        assert.equal(Object.hasOwn(stored, key), false, key);
      }

      // Nothing but the inheritance lineage still names the source.
      const lineageFree = structuredClone(stored);
      delete lineageFree.inheritedFromSessionId;
      for (const message of lineageFree.messages) delete message.meta?.sessionInheritances;
      assert.equal(JSON.stringify(lineageFree).includes(live.id), false);
      assert.equal(stored.inheritedFromSessionId, live.id);

      // Listed as an ordinary, user-visible Lead session.
      const summary = listStoredSessionSummaries({ refreshFromStorage: true }).find((row) => row.id === heirId);
      assert.equal(summary.visibility, 'ordinary');
      const row = listLeadSessions({ listSessions: () => [summary] }).find((entry) => entry.id === heirId);
      assert.ok(row);
      assert.equal(row.inheritedFromSessionId, live.id);
    } finally {
      if (heirId) deleteSession(heirId);
      deleteSession(live.id);
    }
  });
});

test('inheritToNewSession honors compact:true and refuses with the preflight sentence when nothing fits', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const created = [];
    const summaryCount = () => listStoredSessionSummaries({ refreshFromStorage: true }).length;
    const live = openLive(CONVERSATION);
    try {
      // A chosen compaction summarizes even a conversation that fits.
      const compacting = lifecycleFor(live, async ({ sessionId }) => {
        assert.equal(sessionId, live.id);
        return { messages: [{ role: 'user', content: 'Summarized for the heir.' }] };
      });
      const compacted = await compacting.inheritToNewSession(live.id, { compact: true });
      created.push(compacted.sessionId);
      assert.equal(compacted.compacted, true);
      assert.equal(compacted.messages, 1);
      assert.deepEqual(conversationOf(loadSession(compacted.sessionId)), [['user', 'Summarized for the heir.']]);
      assert.deepEqual(conversationOf(live), [
        ['user', 'Plan the migration.'],
        ['assistant', 'Here is the plan.'],
      ]);

      // A requested compaction that cannot run is a refusal; no heir is saved.
      const fault = new Error('compactor down');
      const failing = lifecycleFor(live, async () => {
        throw fault;
      });
      const beforeRefusal = summaryCount();
      await assert.rejects(failing.inheritToNewSession(live.id, { compact: true }), (error) => {
        assert.match(error.message, /could not be compacted/);
        assert.equal(error.cause, fault);
        return true;
      });
      assert.equal(summaryCount(), beforeRefusal);
    } finally {
      for (const id of created) deleteSession(id);
      deleteSession(live.id);
    }

    // Oversized: compacted on the way unless the compaction yields nothing,
    // which refuses with exactly the sentence the preflight's fit produces.
    const huge = openLive([
      { role: 'user', content: 'x'.repeat(700_000) },
      { role: 'assistant', content: 'Read it.' },
    ]);
    try {
      const fit = lifecycleFor(huge).inheritancePreflight(huge.id);
      assert.equal(fit.known, true);
      assert.equal(fit.fits, false);
      assert.equal(fit.willCompact, true);

      const fitting = lifecycleFor(huge, async () => ({ messages: [{ role: 'user', content: 'Short now.' }] }));
      const result = await fitting.inheritToNewSession(huge.id);
      created.push(result.sessionId);
      assert.equal(result.compacted, true);
      assert.deepEqual(conversationOf(loadSession(result.sessionId)), [['user', 'Short now.']]);

      const refusing = lifecycleFor(huge, async () => ({ messages: [] }));
      const beforeRefusal = summaryCount();
      await assert.rejects(refusing.inheritToNewSession(huge.id), { message: inheritanceFitMessage(fit) });
      assert.equal(summaryCount(), beforeRefusal);
    } finally {
      for (const id of created) deleteSession(id);
      deleteSession(huge.id);
    }
  });
});
