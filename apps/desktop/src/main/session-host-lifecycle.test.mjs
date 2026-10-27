import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionHost } from './session-host.ts';
import { sessionSidebarChangeHandler } from './session-sidebar-actions.ts';
import {
  applySessionSidebarChange,
  readSessionSidebarState,
  registerSessionSidebarHost,
} from '../../../../src/runtime/shared/session-sidebar-host.mjs';
import { applySubAgentRetention } from '../../../../src/runtime/agent/orchestrator/session/store/sweep/sub-agent-retention.mjs';

async function fixture(t, close, sessions = []) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-host-lifecycle-'));
  const host = await SessionHost.create(
    {
      userDataPath: root,
      resourcesPath: root,
      appPath: root,
      packaged: false,
    },
    {
      attachSessionClient: async () => ({
        list: async () => ({ sessions }),
        close,
      }),
      loadProjects: async () => ({}),
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(async () => {
    // A test may deliberately leave a failed metadata flush as the terminal
    // result. The assertions below own that rejection; cleanup still runs.
    await host.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { host, root };
}

test('every overlapping host disposal waits for the same attachment cleanup', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let closes = 0;
  const { host } = await fixture(t, async () => {
    closes++;
    entered.resolve();
    await release.promise;
  });
  const first = host.dispose();
  await entered.promise;
  let secondFinished = false;
  const second = host.dispose().then(() => {
    secondFinished = true;
  });
  try {
    await Promise.resolve();
    assert.equal(secondFinished, false);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(closes, 1);
});

test('archiving a session archives its sub-agent sessions; restoring it brings back the ones it took', async (t) => {
  const sub = (id, ownerSessionId) => ({
    id,
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    ownerSessionId,
    messageCount: 2,
    preview: 'work',
  });
  const rows = [
    { id: 'sess_lead', owner: 'user', agent: 'lead', sourceType: 'lead', messageCount: 2, preview: 'lead' },
    sub('sess_w1', 'sess_lead'),
    sub('sess_w2', 'sess_lead'),
    sub('sess_w_other', 'sess_lead_other'),
  ];
  const { host } = await fixture(t, async () => {}, rows);
  // Archived on its own first (the idle sweep): a restore of the Lead keeps it.
  await host.setSessionArchived('sess_w2', true);
  await host.setSessionArchived('sess_lead', true);
  let state = await host.sessionSidebarState();
  assert.deepEqual(Object.keys(state.archived).sort(), ['sess_lead', 'sess_w1', 'sess_w2']);
  await host.setSessionArchived('sess_lead', false);
  state = await host.sessionSidebarState();
  assert.deepEqual(Object.keys(state.archived), ['sess_w2']);
  // A session the store deleted on its own loses its flags.
  await host.forgetSessionMetadata('sess_w2');
  assert.deepEqual((await host.sessionSidebarState()).archived, {});
});

test("sub-agent retention archives exactly its tree's members through the real host, no cascade past them", async (t) => {
  const sub = (id, links, extra = {}) => ({
    id,
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    messageCount: 2,
    preview: 'work',
    ...links,
    ...extra,
  });
  const rows = [
    { id: 'sess_lead', owner: 'user', agent: 'lead', sourceType: 'lead', messageCount: 2, preview: 'lead' },
    sub('sess_t', { ownerSessionId: 'sess_lead', parentSessionId: 'sess_lead' }),
    sub('sess_t_child', { ownerSessionId: 'sess_lead', parentSessionId: 'sess_t' }),
    // Linked under the tree in the catalog, but no retention member: the
    // cascade walker would reach it, retention must not.
    sub('sess_t_outside', { ownerSessionId: 'sess_t' }, { taskOrigin: { agentId: 'mailer' } }),
  ];
  const { host } = await fixture(t, async () => {}, rows);
  // The members' stored records, which retention re-reads before acting.
  const dir = join(process.env.MIXDOG_DATA_DIR, 'sessions');
  await mkdir(dir, { recursive: true });
  const at = Date.now() - 5 * 24 * 60 * 60 * 1000;
  for (const row of rows.slice(1, 3)) {
    await writeFile(
      join(dir, `${row.id}.json`),
      JSON.stringify({ ...row, createdAt: at, updatedAt: at, lastUsedAt: at })
    );
    t.after(() => rm(join(dir, `${row.id}.json`), { force: true }));
  }
  const unregister = registerSessionSidebarHost(sessionSidebarChangeHandler(host), {
    state: () => host.sessionSidebarState(),
  });
  t.after(unregister);
  const flags = await readSessionSidebarState();
  const applied = await applySubAgentRetention(
    [
      { id: 'sess_t', parentId: 'sess_lead', lastActive: at },
      { id: 'sess_t_child', parentId: 'sess_t', lastActive: at },
    ],
    { isArchived: (id) => Object.hasOwn(flags.archived, id), setSidebar: applySessionSidebarChange }
  );
  assert.deepEqual(applied, { archived: ['sess_t', 'sess_t_child'], deleted: [] });
  assert.deepEqual(Object.keys((await host.sessionSidebarState()).archived).sort(), ['sess_t', 'sess_t_child']);
  // An explicit archive of the same parent still cascades along every link.
  await host.setSessionArchived('sess_t', false);
  await host.setSessionArchived('sess_t', true);
  assert.ok(Object.hasOwn((await host.sessionSidebarState()).archived, 'sess_t_outside'));
});

test('a read lands in the session’s own numbering: a surface counting in a retired one cannot read past it', async (t) => {
  const chat = { id: 'sess_chat', owner: 'user', agent: 'lead', sourceType: 'lead', preview: 'chat' };
  // Compacted from 417 messages to 62; the surface still counts 417.
  const { host } = await fixture(t, async () => {}, [{ ...chat, messageCount: 62, compactCount: 17 }]);
  await host.listSessions();
  await host.markSessionRead('sess_chat', 417, false);
  const [listed] = await host.listSessions();
  assert.equal(listed.compactCount, 17);
  assert.equal(listed.readMessageCount, 62);
});

test('failed metadata flushing cannot prevent host attachment cleanup', async (t) => {
  let closes = 0;
  const { host, root } = await fixture(t, async () => {
    closes++;
  });
  t.mock.method(console, 'error', () => {});
  await host.listSessions();
  await mkdir(join(root, 'desktop-session-metadata.json'));
  // The cursor write is deferred, so the failure surfaces when it is settled.
  await host.markSessionRead('session-a', 2, false);
  await assert.rejects(host.dispose());
  assert.equal(closes, 1);
});
