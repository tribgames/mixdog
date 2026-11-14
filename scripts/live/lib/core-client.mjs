// A protocol-2 client of the instance's core: this checkout's scripts/rust-core/lib/core-session.mjs `attachCore`, which
// dials core.rpc.port with endpoints.session.token. It never starts or stops a core. Approvals the scripted turns ask
// for are answered here (approved).
import { join } from 'node:path';

import { attachCore } from '../../rust-core/lib/core-session.mjs';
import { CUSTOM } from './paths.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to the attached core with `request(method, params)` and `onServerRequest(listener)` added. */
export async function attach(profile, { clientName = 'live', approve = true, log = () => {} } = {}) {
  const core = await attachCore({ runtimeRoot: join(profile, 'runtime'), clientName, timeoutMs: 180_000 });
  const approvals = [];
  const serverRequests = [];
  const listeners = new Set();
  core.client.on((event) => {
    if (event.type !== 'serverRequest') return;
    const request = event.request;
    serverRequests.push({ method: request.method, at: Date.now() });
    for (const listener of listeners) listener(request);
    if (approve && /requestApproval$/.test(request.method)) {
      approvals.push({ method: request.method, params: request.params, at: Date.now() });
      log(`approval ${request.method} answered approved`);
      core.client.respond(request.id, { result: { approved: true } });
    }
  });
  return {
    ...core,
    approvals,
    serverRequests,
    request: (method, params) => core.call(method, params),
    onServerRequest(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** An interactive thread (no tool profile: the Lead surface) routed to the scripted provider. */
export async function startThread(core, projectPath, { title } = {}) {
  const r = await core.call('thread/start', {
    kind: 'task',
    projectPath,
    draft: { projectPath, route: { provider: CUSTOM, model: 'smoke' }, orchestrationMode: 'none', ...(title ? { title } : {}) },
  });
  await core.client.resumeThread(r.thread.id, { lastItems: 50 });
  return r.thread.id;
}

export const busy = (core, threadId) => core.client.store.thread(threadId)?.state?.fields?.busy === true;

/** Starts a turn and waits until the thread is idle again (and `until()` holds), steadily for `settleMs`. */
export async function runTurn(core, threadId, prompt, { ms = 600_000, settleMs = 600, until = () => true } = {}) {
  const started = Date.now();
  await core.call('turn/start', { threadId, input: { prompt, options: {} } });
  let quietSince = null;
  let sawBusy = false;
  for (;;) {
    const isBusy = busy(core, threadId);
    sawBusy ||= isBusy;
    if (!isBusy && until() && (sawBusy || Date.now() - started > 3000)) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= settleMs) return { ms: Date.now() - started, sawBusy };
    } else quietSince = null;
    if (Date.now() - started > ms) throw new Error(`turn did not end within ${ms} ms (busy=${isBusy})`);
    await sleep(50);
  }
}

/** `browser/command` through the core (forwarded as host/browser/command; no threadId, so no touchSurface). */
export const browserCommand = (core, action, input = {}) => core.call('browser/command', { action, input });
