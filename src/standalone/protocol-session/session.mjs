// The session view the terminal TUI holds, over `@mixdog/protocol-client`. It has the shape the TUI has always
// received from `createSession`: a synchronous `getState()` (the folded thread feed, i.e. the daemon-owned
// DesktopSessionState projection), `subscribe`, prompt submit/abort, tool approval, session switching, project
// routes, and every finite session action as an async method.
//
// One connection per process is shared by its views; closing the last view closes it. Closing the view sends no
// stop request: the core keeps running work after its last client leaves.
import { TRANSCRIPT_LIVE_ITEM_CAP } from '../../tui/session/transcript-spill.mjs';
import { SESSION_ACTIONS, resolveAction } from './action-route.mjs';
import { createRuntimeNotifications } from './runtime-notifications.mjs';
import { toSessionError } from './session-error.mjs';

const LOCAL_TARGET = Object.freeze({ id: 'local' });
const RESUME_WINDOW = Object.freeze({ lastItems: TRANSCRIPT_LIVE_ITEM_CAP });
const NO_STATE = Object.freeze({});
const THREAD_LIST_KEYS = ['cursor', 'limit', 'sortKey', 'sortDirection', 'archived', 'cwd', 'searchTerm'];

// Desktop-only live field: `streamingPartial` is the unfinished streamed line the desktop paints ahead of the
// line-gated tail. This terminal view keeps the line-gated text, so it never holds the field.
const DESKTOP_ONLY_FIELDS = ['streamingPartial'];

function terminalState(full) {
  if (!DESKTOP_ONLY_FIELDS.some((key) => Object.hasOwn(full, key))) return full;
  const next = { ...full };
  for (const key of DESKTOP_ONLY_FIELDS) delete next[key];
  return next;
}

const defined = (params) => Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));

export function createProtocolSessionFactory({
  connect,
  connector,
  ensureCore,
  threadReducer,
  stateOf,
  clientInfo,
  capabilities = {},
  clock,
  random,
  newOpId,
}) {
  if (typeof threadReducer?.apply !== 'function') throw new TypeError('threadReducer is required');
  if (typeof stateOf !== 'function') throw new TypeError('stateOf is required');
  let shared = null;

  function acquire(log) {
    if (!shared) {
      const entry = { views: 0, ready: null };
      entry.ready = (async () => {
        await ensureCore({ log });
        return connect({
          target: LOCAL_TARGET,
          connector,
          clientInfo,
          capabilities,
          threadReducer,
          clock,
          random,
          ...(newOpId ? { newOpId } : {}),
        });
      })();
      entry.ready.catch(() => {
        if (shared === entry) shared = null;
      });
      shared = entry;
    }
    const entry = shared;
    entry.views += 1;
    return entry.ready.then(
      (client) => ({ entry, client }),
      (error) => {
        entry.views -= 1;
        throw toSessionError(error);
      }
    );
  }

  async function release(entry) {
    entry.views -= 1;
    if (entry.views > 0) return;
    if (shared === entry) shared = null;
    await (await entry.ready).close();
  }

  return async function createSession(options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const cwd = options.cwd || process.cwd();
    const toolMode = options.toolMode || 'full';
    const { entry, client } = await acquire(log);
    const binding = { threadId: '', cwd: undefined, disposed: false };
    const listeners = new Set();
    const submissionOpIds = new Map();

    const call = async (method, params, callOptions) => {
      try {
        return await client.call(method, params, callOptions);
      } catch (error) {
        throw toSessionError(error);
      }
    };
    const assertLive = () => {
      if (binding.disposed) throw new Error('This session view is disposed.');
    };
    const emit = () => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          log(`session listener threw: ${error?.message || error}`);
        }
      }
    };
    // The state is the thread fold joined with the pending server requests and the shell-job section; it is
    // recomputed once per change of any of them, so `getState()` is stable between changes (React compares it by
    // identity).
    let version = 0;
    // Node's runtime notifications (the updater's `update-notice`) arrive as the app feed's `notice` entry.
    const runtimeNotifications = createRuntimeNotifications({ store: client.store, log });
    const stopStore = client.store.subscribe((change) => {
      runtimeNotifications.onChange(change);
      const mine =
        (change.type === 'thread' && change.threadId === binding.threadId) ||
        (change.type === 'section' && change.section === 'hostShellJobs');
      if (!mine) return;
      version += 1;
      emit();
    });
    const stopEvents = client.on((event) => {
      if (event.type === 'status' && event.status.state === 'reconnecting') {
        log(`session ${binding.threadId} reconnecting (attempt ${event.status.attempt})`);
      } else if (event.type === 'subscriptionLost') {
        log(`session ${event.threadId} is no longer available (${event.error.kind})`);
      } else if (event.type === 'protocolViolation') {
        log(`session protocol violation: ${event.what}`);
      }
    });

    let derivedAt = -1;
    let derived = NO_STATE;
    function getState() {
      if (derivedAt !== version) {
        const full = binding.threadId ? stateOf(client, binding.threadId) : undefined;
        // The terminal's state also names the folder the thread works in, which the thread summary carries.
        derived = full ? terminalState(full.cwd === undefined ? { ...full, cwd: binding.cwd } : full) : NO_STATE;
        derivedAt = version;
      }
      return derived;
    }

    async function startThread() {
      const route = options.provider && options.model ? { provider: options.provider, model: options.model } : null;
      const draft = defined({ route: route ?? undefined, worktree: options.worktree ?? undefined });
      const started = await call(
        'thread/start',
        defined({ kind: 'project', projectPath: cwd, draft: Object.keys(draft).length ? draft : undefined })
      );
      const threadId = String(started?.thread?.id || '');
      if (!threadId) throw new Error('thread/start returned no thread');
      if (toolMode !== 'full') await call('thread/setToolMode', { threadId, mode: toolMode });
      return threadId;
    }

    // The resume response comes before the snapshot that creates the fold; a view is returned (and a switch
    // completes) only once its first state exists, as it was when the create result seeded the projection.
    function folded(threadId) {
      return new Promise((resolve, reject) => {
        if (client.store.thread(threadId)) return resolve();
        const stops = [];
        const settle = (finish) => {
          for (const stop of stops) stop();
          finish();
        };
        stops.push(
          client.store.subscribe((change) => {
            if (change.type === 'thread' && change.threadId === threadId && client.store.thread(threadId)) {
              settle(resolve);
            }
          }),
          client.on((event) => {
            if (event.type === 'subscriptionLost' && event.threadId === threadId) {
              settle(() => reject(toSessionError(Object.assign(new Error(event.error.kind), { detail: event.error }))));
            }
          })
        );
      });
    }

    async function follow(threadId) {
      try {
        const { thread } = await client.resumeThread(threadId, RESUME_WINDOW);
        await folded(threadId);
        return thread.cwd;
      } catch (error) {
        throw toSessionError(error);
      }
    }

    async function moveTo(threadId, cwdOfThread) {
      const previous = binding.threadId;
      binding.threadId = threadId;
      binding.cwd = cwdOfThread;
      version += 1;
      if (previous && previous !== threadId) {
        try {
          await client.unsubscribeThread(previous);
        } catch (error) {
          log(`session ${previous} unsubscribe failed: ${error?.message || error}`);
        }
      }
      emit();
    }

    let transitionChain = Promise.resolve();
    const serializeTransition = (task) => {
      const run = transitionChain.then(task);
      transitionChain = run.then(
        () => {},
        () => {}
      );
      return run;
    };
    const afterPendingTransition = () => transitionChain;

    try {
      const threadId = await startThread();
      binding.cwd = await follow(threadId);
      binding.threadId = threadId;
      version += 1;
    } catch (error) {
      stopStore();
      stopEvents();
      await release(entry).catch(() => {});
      throw error;
    }

    async function submitAsync(prompt, submitOptions = {}) {
      assertLive();
      let submissionId = String(submitOptions?.id || '').trim();
      if (!submissionId) submissionId = `session-submit-${process.pid}-${Date.now()}-${submissionOpIds.size + 1}`;
      await afterPendingTransition();
      assertLive();
      // The same submission keeps the same op id, so a retry after a lost socket cannot run it twice.
      const key = `${binding.threadId}:${submissionId}`;
      if (!submissionOpIds.has(key)) submissionOpIds.set(key, newOpId?.());
      const { id: _id, ...rest } = submitOptions || {};
      const input = { prompt, options: { ...rest, clientSubmissionId: submissionId } };
      const opId = submissionOpIds.get(key);
      const response = await call(
        'turn/start',
        { threadId: binding.threadId, input },
        opId === undefined ? undefined : { opId }
      );
      submissionOpIds.delete(key);
      return response?.kind === 'started' || response?.kind === 'queued';
    }

    async function abortAsync(abortOptions = {}) {
      if (binding.disposed) return { aborted: false };
      await afterPendingTransition();
      if (binding.disposed) return { aborted: false };
      const response = await call(
        'turn/interrupt',
        defined({
          threadId: binding.threadId,
          restorePrompt: abortOptions?.restorePrompt,
          submissionId: abortOptions?.submissionId,
        })
      );
      return { aborted: response?.cancelRequested === true, turnId: response?.turnId };
    }

    const remoteCall = (action, args) => {
      if (binding.disposed) return Promise.reject(new Error('This session view is disposed.'));
      return afterPendingTransition().then(async () => {
        assertLive();
        const { method, params } = resolveAction(action, args, { threadId: binding.threadId });
        return (await call(method, params)) ?? null;
      });
    };

    const projectCall = async (method, params, pick) => pick(await call(method, params));

    const base = {
      isRemoteSession: true,
      get disposedView() {
        return binding.disposed;
      },
      getState,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onNotification: (listener) => runtimeNotifications.onNotification(listener),
      async listSessions(listOptions = {}) {
        const filter = defined(Object.fromEntries(THREAD_LIST_KEYS.map((key) => [key, listOptions?.[key]])));
        if (listOptions?.page && typeof listOptions.page === 'object') {
          const page = await call('thread/list', { ...filter, ...defined({ limit: listOptions.page.limit, cursor: listOptions.page.cursor }) });
          return Array.isArray(page?.data) ? page.data : [];
        }
        const sessions = [];
        let cursor = filter.cursor;
        do {
          const page = await call('thread/list', defined({ ...filter, cursor }));
          if (Array.isArray(page?.data)) sessions.push(...page.data);
          cursor = page?.nextCursor;
        } while (cursor);
        return sessions;
      },
      async listProjects() {
        const result = await call('project/list', {});
        return Array.isArray(result?.projects) ? result.projects : [];
      },
      inspectProjectPath: (path) => call('project/read', { path }),
      addProject: (path) => projectCall('project/create', { path }, (r) => r?.project ?? null),
      touchProjectSelected: (path) => projectCall('project/touch', { path }, (r) => r?.project ?? null),
      renameProject: (path, name) => projectCall('project/update', { path, alias: name }, (r) => r?.project ?? null),
      removeProject: (path) => projectCall('project/delete', { path }, (r) => r?.removed === true),
      ensureProjectDirectory: (path) => projectCall('project/ensureDirectory', { path }, (r) => String(r?.path || '')),
      async newSession() {
        await serializeTransition(async () => {
          assertLive();
          const threadId = await startThread();
          await moveTo(threadId, await follow(threadId));
        });
        return true;
      },
      async resume(targetSessionId) {
        const target = String(targetSessionId || '');
        if (!target) return false;
        return serializeTransition(async () => {
          assertLive();
          if (target === binding.threadId) return true;
          await moveTo(target, await follow(target));
          return true;
        });
      },
      async prefetchSession(targetSessionId) {
        const target = String(targetSessionId || '');
        if (!target) return false;
        await call('thread/read', { threadId: target, window: RESUME_WINDOW });
        return true;
      },
      submitAsync,
      submit(prompt, submitOptions) {
        if (binding.disposed) return false;
        void submitAsync(prompt, submitOptions).catch((error) => {
          log(`session submit failed: ${error?.message || error}`);
        });
        return true;
      },
      abortAsync,
      abort(abortOptions = {}) {
        void abortAsync(abortOptions).catch((error) => log(`session abort failed: ${error?.message || error}`));
        return true;
      },
      resolveToolApproval(id, decision) {
        if (binding.disposed) return true;
        try {
          client.respond(String(id), { result: decision });
        } catch (error) {
          log(`session approval failed: ${error?.message || error}`);
        }
        return true;
      },
      async dispose() {
        if (binding.disposed) return;
        binding.disposed = true;
        stopStore();
        stopEvents();
        listeners.clear();
        runtimeNotifications.clear();
        const threadId = binding.threadId;
        try {
          await client.unsubscribeThread(threadId);
        } catch (error) {
          log(`session ${threadId} unsubscribe failed: ${error?.message || error}`);
        }
        await release(entry).catch(() => {});
      },
    };

    for (const action of SESSION_ACTIONS) {
      if (!Object.hasOwn(base, action)) base[action] = (...args) => remoteCall(action, args);
    }
    return base;
  };
}
