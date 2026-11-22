import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmText } from './confirm-text.ts';
import { t as translate } from './i18n.ts';

test('confirmText collapses newlines and truncates long commands to one ~100-char line', () => {
  assert.equal(confirmText('echo a\n  echo b\r\n'), 'echo a echo b');
  const shown = confirmText(`node -e "${'x'.repeat(500)}"\nrm -rf /`);
  assert.equal(Array.from(shown).length, 100);
  assert.equal(shown.endsWith('…'), true);
  assert.equal(shown.includes('\n'), false);
  assert.equal(confirmText('short'), 'short');
});
import {
  backgroundJobRows,
  shellCommandTitle,
  expiredShellRows,
  shellFinishedLabel,
  shellRowAction,
  shellStopOutcome,
} from './background-jobs-model.ts';
import {
  dismissedShellJobs,
  dismissShellJobs,
  resetDismissedShellJobsCache,
} from './background-jobs-dismissed-store.ts';

const snapshot = {
  shellJobs: {
    count: 1,
    elapsedLabel: '',
    jobs: [{ taskId: 'job_3', command: 'npm run dev', cwd: '', startedAt: 3000 }],
    finished: [
      {
        taskId: 'job_1',
        command: 'make',
        cwd: '',
        startedAt: 1000,
        status: 'completed',
        exitCode: 0,
        finishedAt: 2000,
      },
      { taskId: 'job_2', command: 'test', cwd: '', startedAt: 1500, status: 'failed', exitCode: 2, finishedAt: 2500 },
    ],
  },
};

test('finished shell rows follow running ones, newest finish first, with exit info', () => {
  const rows = backgroundJobRows(snapshot);
  assert.deepEqual(
    rows.map((row) => [row.key, Boolean(row.finished)]),
    [
      ['shell:job_3', false],
      ['shell:job_2', true],
      ['shell:job_1', true],
    ]
  );
  assert.equal(rows[1].exitCode, 2);
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[2].exitCode, 0);
});

test('shell row action follows the stop state; finished rows only dismiss', () => {
  const running = { finished: false };
  assert.equal(shellRowAction(running, undefined), 'stop');
  assert.equal(shellRowAction(running, 'stopping'), 'stopping');
  assert.equal(shellRowAction(running, 'failed'), 'retry');
  assert.equal(shellRowAction(running, 'unconfirmed'), 'stopping');
  assert.equal(shellRowAction({ finished: true }, 'stopping'), 'dismiss');
});

test('finished shell labels: exit 0 reads Exited, a stop Stopped, anything else Failed', () => {
  assert.equal(shellFinishedLabel({ status: 'completed', exitCode: 0 }), translate('Island: Exited'));
  assert.equal(shellFinishedLabel({ status: 'cancelled', exitCode: 1 }), translate('Island: Stopped'));
  assert.equal(shellFinishedLabel({ status: 'failed', exitCode: 2 }), translate('Failed'));
  assert.equal(shellFinishedLabel({ status: 'completed', exitCode: null }), translate('Failed'));
  assert.equal(shellFinishedLabel({ status: 'failed', exitCode: 0 }), translate('Failed'));
});

test('only clean exits expire, SHELL_AUTO_DISMISS_MS after they finished (or were first seen)', () => {
  const row = (key, exitCode, finishedAt, status = 'completed') => ({
    key,
    kind: 'shell',
    label: key,
    startedAt: 0,
    finished: true,
    exitCode,
    status,
    finishedAt,
  });
  const rows = [
    { key: 'run', kind: 'shell', label: 'run', startedAt: 0 },
    row('ok-old', 0, 1_000),
    row('ok-new', 0, 50_000),
    row('ok-unknown', 0, 0),
    row('failed', 2, 1_000, 'failed'),
    row('stopped', null, 1_000, 'cancelled'),
  ];
  const seen = () => 30_000;
  assert.deepEqual(expiredShellRows(rows, 61_000, seen), { keys: ['ok-old'], nextAt: 90_000 });
  assert.deepEqual(expiredShellRows(rows, 110_000, seen), { keys: ['ok-old', 'ok-new', 'ok-unknown'], nextAt: 0 });
});

test("a shell row's title is its first command, quoted text kept whole", () => {
  assert.equal(shellCommandTitle('npm test -- --changed 2>&1 | Select-String fail'), 'npm test -- --changed');
  assert.equal(shellCommandTitle('npm run build; npm test'), 'npm run build');
  assert.equal(shellCommandTitle('cargo check && cargo test'), 'cargo check');
  assert.equal(shellCommandTitle('node run.mjs "a | b; c" 9407 > out.txt'), 'node run.mjs "a | b; c" 9407');
  assert.equal(shellCommandTitle('npm run dev'), 'npm run dev');
  assert.equal(shellCommandTitle('| odd'), '| odd');
});

test('a shell job row carries its working directory', () => {
  assert.equal(
    backgroundJobRows({
      shellJobs: { count: 1, elapsedLabel: '', jobs: [{ taskId: 'a', command: 'x', cwd: '/w/p', startedAt: 1 }] },
    })[0].taskId,
    'a'
  );
});

test('dismissed finished rows never come back, and persist per session', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  resetDismissedShellJobsCache();
  dismissShellJobs('sess-x', ['shell:job_2']);
  assert.deepEqual(
    backgroundJobRows(snapshot, dismissedShellJobs('sess-x')).map((row) => row.key),
    ['shell:job_3', 'shell:job_1']
  );
  // A fresh load reads the persisted ids; other sessions are unaffected.
  resetDismissedShellJobsCache();
  assert.ok(dismissedShellJobs('sess-x').has('shell:job_2'));
  assert.equal(dismissedShellJobs('sess-y').size, 0);
  delete globalThis.localStorage;
});

test('one dismissal hides every clearable agent row, and drops only the keys a newer outcome replaced', async () => {
  const { dismissFinishedAgentRows, withoutDismissedAgentRows } = await import('./agent-dismiss.ts');
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  resetDismissedShellJobsCache();
  const rows = Array.from({ length: 300 }, (_, index) => ({
    sessionId: `child-${index}`,
    ownerSessionId: 'lead',
    agent: 'worker',
    settledAt: 1000 + index,
  }));
  assert.equal(dismissFinishedAgentRows(rows, rows), 300);
  assert.equal(withoutDismissedAgentRows(rows).length, 0);

  const kept = rows.slice(0, 5);
  const fresh = { sessionId: 'child-new', ownerSessionId: 'lead', agent: 'worker', settledAt: 9000 };
  const rerun = { ...rows[299], settledAt: 5000 };
  dismissFinishedAgentRows([fresh], [...kept, fresh, rerun]);
  const stored = dismissedShellJobs('lead');
  assert.equal(stored.size, 300);
  assert.ok(stored.has('agent:child-0@1000') && stored.has('agent:child-new@9000'));
  assert.ok(stored.has('agent:child-7@1007'), 'an agent the listing leaves out keeps its cleared outcome');
  assert.equal(stored.has('agent:child-299@1299'), false, 'a newer outcome of the agent replaced the cleared one');

  dismissFinishedAgentRows([{ ...fresh, sessionId: 'child-next' }], null);
  assert.equal(dismissedShellJobs('lead').size, 301);
  delete globalThis.localStorage;
});

test('a count-only stub or missing pool is no listing and does not prune; a real [] is the listing', async () => {
  const { agentPoolStore, startAgentPool } = await import('./agent-activity-model.ts');
  const { dismissFinishedAgentRows } = await import('./agent-dismiss.ts');
  const { sectionStoreFor } = await import('./section-store.ts');
  const store = new Map([['mixdog.dismissedShellJobs.lead', JSON.stringify(['agent:old@1', 'shell:x'])]]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const hostWith = (entries) => ({
    sections: {
      snapshot: async () => ({ status: 'ready', entries }),
      subscribe: () => () => {},
    },
  });
  const entry = (value) => ({ section: 'agentPool', key: null, revision: 2, value });
  const load = async (entries) => {
    const host = hostWith(entries);
    globalThis.window = { mixdogDesktop: host };
    await sectionStoreFor(host).ready();
    startAgentPool(agentPoolStore(host));
    await sectionStoreFor(host).ready();
    return agentPoolStore(host);
  };
  try {
    const row = { sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', settledAt: 5 };
    for (const entries of [[entry(null)], []]) {
      resetDismissedShellJobsCache();
      const pool = await load(entries);
      assert.equal(pool.getSnapshot(), null);
      assert.equal(pool.getListing(), null);
      dismissFinishedAgentRows([row]);
      assert.ok(dismissedShellJobs('lead').has('agent:old@1'));
      assert.ok(dismissedShellJobs('lead').has('agent:c1@5'));
    }
    resetDismissedShellJobsCache();
    const pool = await load([entry([])]);
    assert.deepEqual(pool.getSnapshot(), []);
    assert.deepEqual(pool.getListing(), []);
    dismissFinishedAgentRows([row]);
    assert.ok(
      dismissedShellJobs('lead').has('agent:old@1'),
      'an agent the listing leaves out may come back with the same outcome'
    );
    resetDismissedShellJobsCache();
    await load([entry([{ sessionId: 'old', ownerSessionId: 'lead', agent: 'worker', settledAt: 9 }])]);
    dismissFinishedAgentRows([row]);
    assert.equal(dismissedShellJobs('lead').has('agent:old@1'), false, 'its newer outcome replaced the cleared one');
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete globalThis.window;
    delete globalThis.localStorage;
  }
});

test('a stub pool is read through listAgentPool, and a read a newer push overtook is dropped', async () => {
  const { agentPoolStore, startAgentPool } = await import('./agent-activity-model.ts');
  const { sectionStoreFor } = await import('./section-store.ts');
  const rows = [{ sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', idleSince: 5 }];
  let reads = 0;
  let push = () => {};
  let release = () => {};
  const entry = (revision, value) => ({ section: 'agentPool', key: null, revision, value });
  const host = {
    sections: {
      snapshot: async () => ({ status: 'ready', entries: [entry(2, null)] }),
      subscribe: (next) => {
        push = next;
        return () => {};
      },
    },
    listAgentPool: () => {
      reads += 1;
      return reads === 1
        ? new Promise((resolve) => (release = () => resolve([{ ...rows[0], stale: true }])))
        : Promise.resolve(rows);
    },
  };
  await sectionStoreFor(host).ready();
  const store = agentPoolStore(host);
  startAgentPool(store);
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.getListing(), null);
  // A second stub push overtakes the first, still pending, read.
  push({ kind: 'sections', changes: [{ section: 'agentPool', key: null, entry: entry(3, null) }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(store.getSnapshot(), rows);
  assert.deepEqual(store.getListing(), rows);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(store.getSnapshot(), rows);
  assert.ok(reads >= 2);
});

/** A host whose pool section starts as `entries` and is then pushed by `push`; each `listAgentPool` read waits until the
 *  test settles it through `reads`. */
async function poolHost(entries) {
  const { agentPoolStore, startAgentPool } = await import('./agent-activity-model.ts');
  const { sectionStoreFor } = await import('./section-store.ts');
  const reads = [];
  const host = {
    push: () => {},
    sections: {
      snapshot: async () => ({ status: 'ready', entries }),
      subscribe: (next) => {
        host.push = next;
        return () => {};
      },
    },
    listAgentPool: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
  };
  await sectionStoreFor(host).ready();
  const pool = agentPoolStore(host);
  startAgentPool(pool);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { host, pool, reads };
}

const poolEntry = (revision, value) => ({ section: 'agentPool', key: null, revision, value });
const pushPool = (host, entry) =>
  host.push({ kind: 'sections', changes: [{ section: 'agentPool', key: null, entry }] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function withDismissStore(seed, body) {
  const store = new Map(
    Object.entries(seed).map(([owner, keys]) => [`mixdog.dismissedShellJobs.${owner}`, JSON.stringify(keys)])
  );
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  resetDismissedShellJobsCache();
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  return Promise.resolve(body()).finally(() => {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete globalThis.window;
    delete globalThis.localStorage;
  });
}

test('a stub after an inline [] keeps the [] shown, but it is no listing until the read lands', () =>
  withDismissStore({ lead: ['agent:old@1'] }, async () => {
    const { dismissFinishedAgentRows } = await import('./agent-dismiss.ts');
    const { host, pool, reads } = await poolHost([poolEntry(2, [])]);
    globalThis.window = { mixdogDesktop: host };
    assert.deepEqual(pool.getListing(), []);
    pushPool(host, poolEntry(3, null));
    assert.deepEqual(pool.getSnapshot(), []);
    assert.equal(pool.getListing(), null);
    dismissFinishedAgentRows([{ sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', settledAt: 5 }]);
    assert.ok(dismissedShellJobs('lead').has('agent:old@1'), 'the pending read prunes nothing');
    const listed = [{ sessionId: 'old', ownerSessionId: 'lead', agent: 'worker', settledAt: 1 }];
    reads.at(-1).resolve(listed);
    await tick();
    assert.deepEqual(pool.getListing(), listed);
  }));

test('a failed stub read leaves the cached rows shown and no listing', () =>
  withDismissStore({ lead: ['agent:old@1'] }, async () => {
    const { dismissFinishedAgentRows } = await import('./agent-dismiss.ts');
    const cached = [{ sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', settledAt: 5 }];
    const { host, pool, reads } = await poolHost([poolEntry(2, cached)]);
    globalThis.window = { mixdogDesktop: host };
    pushPool(host, poolEntry(3, null));
    reads.at(-1).reject(new Error('list failed'));
    await tick();
    assert.deepEqual(pool.getSnapshot(), cached);
    assert.equal(pool.getListing(), null);
    dismissFinishedAgentRows(cached);
    assert.ok(dismissedShellJobs('lead').has('agent:old@1'));
  }));

test('removing the pool section, by deletion or a replacement without it, drops the read in flight', async () => {
  const { host, pool, reads } = await poolHost([poolEntry(2, null)]);
  const stale = [{ sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', settledAt: 5 }];
  pushPool(host, null);
  reads[0].resolve(stale);
  await tick();
  assert.equal(pool.getSnapshot(), null);
  assert.equal(pool.getListing(), null);

  pushPool(host, poolEntry(4, null));
  host.push({ kind: 'replace', stage: 'begin' });
  host.push({ kind: 'replace', stage: 'commit', epoch: 'e1' });
  reads.at(-1).resolve(stale);
  await tick();
  assert.equal(pool.getSnapshot(), null);
  assert.equal(pool.getListing(), null);
});

test('a host without sections shows an empty pool that is no listing', async () => {
  const { agentPoolStore, startAgentPool } = await import('./agent-activity-model.ts');
  const pool = agentPoolStore({});
  startAgentPool(pool);
  assert.deepEqual(pool.getSnapshot(), []);
  assert.equal(pool.getListing(), null);
});

test('a cleared child that runs again is shown while it runs and after it settles under its new identity', () =>
  withDismissStore({}, async () => {
    const { dismissFinishedAgentRows, withoutDismissedAgentRows } = await import('./agent-dismiss.ts');
    const child = { sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', status: 'idle', stage: 'idle' };
    const settled = { ...child, settledAt: 4 };
    const { host, pool } = await poolHost([poolEntry(2, [settled])]);
    globalThis.window = { mixdogDesktop: host };
    const shown = () => withoutDismissedAgentRows(pool.getSnapshot()).map((row) => row.sessionId);
    assert.equal(dismissFinishedAgentRows([settled]), 1);
    assert.deepEqual(shown(), []);
    pushPool(host, poolEntry(3, [{ ...child, status: 'running', stage: 'running', settledAt: null }]));
    assert.deepEqual(shown(), ['c1'], 'running work is always shown');
    pushPool(host, poolEntry(4, [{ ...settled, settledAt: 9 }]));
    assert.deepEqual(shown(), ['c1'], 'the new outcome is not the cleared one');
    assert.ok(dismissedShellJobs('lead').has('agent:c1@4'));
    assert.equal(dismissedShellJobs('lead').has('agent:c1@9'), false);
  }));

test('a cleared child the listing leaves out for a while stays cleared when it comes back', () =>
  withDismissStore({}, async () => {
    const { dismissFinishedAgentRows, hostDismissListing, withoutDismissedAgentRows } = await import(
      './agent-dismiss.ts'
    );
    const child = {
      sessionId: 'c1',
      ownerSessionId: 'lead',
      agent: 'worker',
      status: 'idle',
      stage: 'idle',
      settledAt: 4,
    };
    const { host, pool } = await poolHost([poolEntry(2, [child])]);
    globalThis.window = { mixdogDesktop: host };
    assert.equal(dismissFinishedAgentRows([child]), 1);
    pushPool(host, poolEntry(3, []));
    assert.deepEqual(pool.getListing(), []);
    dismissShellJobs('lead', ['shell:a'], hostDismissListing('lead', new Set(['shell:a'])));
    pushPool(host, poolEntry(4, [child]));
    assert.deepEqual(withoutDismissedAgentRows(pool.getSnapshot()), [], 'the same outcome is still the cleared one');
  }));

test('a dismissal made while a cleared child runs keeps its cleared outcome; a newer clear of the child replaces it', () =>
  withDismissStore({}, async () => {
    const { dismissFinishedAgentRows, hostDismissListing } = await import('./agent-dismiss.ts');
    const child = { sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', status: 'idle', stage: 'idle' };
    const { host } = await poolHost([poolEntry(2, [{ ...child, settledAt: 4 }])]);
    globalThis.window = { mixdogDesktop: host };
    assert.equal(dismissFinishedAgentRows([{ ...child, settledAt: 4 }]), 1);
    pushPool(host, poolEntry(3, [{ ...child, status: 'running', stage: 'running', settledAt: null }]));
    dismissShellJobs('lead', ['shell:a'], hostDismissListing('lead', new Set(['shell:a'])));
    assert.ok(dismissedShellJobs('lead').has('agent:c1@4'), 'a running row names no other outcome');
    assert.equal(dismissFinishedAgentRows([{ ...child, settledAt: 9 }], null), 1);
    const agents = [...dismissedShellJobs('lead')].filter((key) => key.startsWith('agent:'));
    assert.deepEqual(agents, ['agent:c1@9'], 'the clear of a later outcome is the only key the child keeps');
    pushPool(host, poolEntry(4, [{ ...child, settledAt: 9 }]));
    assert.equal(dismissFinishedAgentRows([{ ...child, settledAt: 4 }]), 1);
    assert.ok(
      dismissedShellJobs('lead').has('agent:c1@9'),
      'a clear carrying an older outcome leaves the later one cleared'
    );
  }));

test('a dismissal is keyed on settledAt alone, and a row without one is not clearable', async () => {
  const { dismissFinishedAgentRows, withoutDismissedAgentRows } = await import('./agent-dismiss.ts');
  await withDismissStore({}, () => {
    const row = { sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', idleSince: 5, updatedAt: 5, settledAt: 4 };
    assert.equal(dismissFinishedAgentRows([row], null), 1);
    assert.equal(withoutDismissedAgentRows([{ ...row, idleSince: 9, updatedAt: 9 }]).length, 0);
    assert.equal(withoutDismissedAgentRows([{ ...row, settledAt: 12 }]).length, 1);
    const unfixed = { ...row, sessionId: 'c2', settledAt: null };
    assert.equal(dismissFinishedAgentRows([unfixed], null), 0);
    assert.equal(withoutDismissedAgentRows([unfixed]).length, 1);
  });
});

test('a transcript preview lane lists no shells, so it never prunes shell dismissals', async () => {
  const { listedShellKeys } = await import('./background-jobs-model.ts');
  const rows = [{ key: 'shell:a' }];
  assert.equal(listedShellKeys({ transcriptPreview: true }, rows), null);
  assert.equal(listedShellKeys(null, rows), null);
  assert.deepEqual([...listedShellKeys({}, rows)], ['shell:a']);
});

test("a second owner's shell keys stay when one Clean up spans owners", async () => {
  const { dismissFinishedAgentRows } = await import('./agent-dismiss.ts');
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  resetDismissedShellJobsCache();
  dismissShellJobs('mid', ['shell:keep']);
  dismissShellJobs('lead', ['shell:gone']);
  const child = { sessionId: 'c1', ownerSessionId: 'lead', agent: 'worker', settledAt: 1 };
  const grandchild = { sessionId: 'g1', ownerSessionId: 'mid', agent: 'worker', settledAt: 2 };
  dismissFinishedAgentRows([child, grandchild], [child, grandchild], { sessionId: 'lead', keys: new Set() });
  assert.ok(dismissedShellJobs('mid').has('shell:keep'));
  assert.equal(dismissedShellJobs('lead').has('shell:gone'), false);
  delete globalThis.localStorage;
});

test('a running shell that leaves the running list is kept until its finished record, or a bounded grace', async () => {
  const { EMPTY_SHELL_ROW_RETENTION, retainVanishedShellRows, SHELL_FINISH_GRACE_MS } = await import(
    './background-jobs-model.ts'
  );
  const running = (id, startedAt) => ({ shellJobs: { count: 1, jobs: [{ taskId: id, command: id, startedAt }] } });
  const finished = (id, startedAt) => ({
    shellJobs: {
      count: 0,
      jobs: [],
      finished: [{ taskId: id, command: id, startedAt, status: 'completed', exitCode: 0, finishedAt: 5000 }],
    },
  });
  let retention = EMPTY_SHELL_ROW_RETENTION;
  const step = (snap, now) => {
    const out = retainVanishedShellRows(retention, backgroundJobRows(snap), now);
    retention = out.retention;
    return out;
  };
  step(running('job_32', 1000), 10_000);
  // The host frame between the two: not running, not yet finished.
  const gap = step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 10_050);
  assert.deepEqual(
    gap.rows.map((row) => [row.key, Boolean(row.finished)]),
    [['shell:job_32', false]],
    'never dropped'
  );
  assert.equal(gap.expiresAt, 10_050 + SHELL_FINISH_GRACE_MS);
  const again = step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 10_900);
  assert.equal(again.rows.length, 1, 'still kept on a repeated frame');
  assert.equal(again.expiresAt, 10_050 + SHELL_FINISH_GRACE_MS, 'the grace does not restart');
  const done = step(finished('job_32', 1000), 11_000);
  assert.deepEqual(
    done.rows.map((row) => [row.key, Boolean(row.finished)]),
    [['shell:job_32', true]],
    'replaced, not duplicated'
  );
  assert.equal(done.expiresAt, 0);
  // A finished record that never comes lapses after the grace.
  step(running('job_40', 2000), 20_000);
  step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 20_100);
  assert.equal(
    step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 20_100 + SHELL_FINISH_GRACE_MS - 1).rows.length,
    1
  );
  assert.equal(
    step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 20_100 + SHELL_FINISH_GRACE_MS).rows.length,
    0
  );
});

test('a Stop of a job that had already ended is not a failed stop', () => {
  assert.equal(shellStopOutcome({ stopped: true }), 'done');
  assert.equal(shellStopOutcome({ stopped: false, finished: true, error: 'task already cancelled: job_1' }), 'done');
  assert.equal(
    shellStopOutcome({ stopped: false, unconfirmed: true, error: 'cancellation not confirmed' }),
    'unconfirmed'
  );
  assert.equal(shellStopOutcome({ stopped: false, error: 'task not found: job_1' }), 'failed');
  assert.equal(shellStopOutcome(undefined), 'failed');
});
