'use strict';

// Runtime-shard client for distributed Agent control.
//
// A Lead runtime and every Subagent it creates used to share one worker
// process even after top-level session sharding. Agent control now crosses the
// existing shard IPC link: the daemon chooses a target shard, while the target
// keeps the ordinary persistent Agent tool/tag/session implementation.
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { isSessionRuntimeWorkerProcess } from '../runtime/shared/child-spawn-remote.mjs';

const pending = new Map();
let sequence = 0;
let listening = false;

function remoteError(body) {
  const error = new Error(String(body?.message || 'remote agent control failed'));
  if (body?.name) error.name = String(body.name);
  if (body?.stack) error.stack = String(body.stack);
  if (body?.code) error.code = String(body.code);
  return error;
}

function ensureListener() {
  if (listening) return;
  listening = true;
  process.on('message', (message) => {
    if (!message || message.type !== 'agent-control-result') return;
    const controlId = String(message.controlId || '');
    const request = pending.get(controlId);
    if (!request) return;
    pending.delete(controlId);
    request.cleanup();
    if (message.ok === false) request.reject(remoteError(message.error));
    else request.resolve(message.value);
  });
  process.on('disconnect', () => {
    for (const [controlId, request] of pending) {
      pending.delete(controlId);
      request.cleanup();
      request.reject(new Error('runtime shard disconnected during agent control'));
    }
  });
}

export function remoteAgentControlEnabled(env = process.env) {
  return isSessionRuntimeWorkerProcess(env)
    && typeof process.send === 'function'
    && process.connected === true;
}

export function executeRemoteAgentControl(args = {}, context = {}) {
  if (!remoteAgentControlEnabled()) {
    return Promise.reject(new Error('remote agent control is unavailable'));
  }
  ensureListener();
  const controlId = `agent-control-${process.pid}-${++sequence}`;
  const signal = context?.signal || null;
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason || 'agent control canceled')));
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
      onAbort = null;
    };
    pending.set(controlId, { resolve, reject, cleanup });
    if (signal) {
      onAbort = () => {
        safeIpcSend(process, {
          type: 'agent-control-cancel',
          controlId,
          reason: String(signal.reason?.message || signal.reason || 'agent control canceled'),
        }, { onError: () => {} });
        const request = pending.get(controlId);
        if (!request) return;
        pending.delete(controlId);
        cleanup();
        reject(signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason || 'agent control canceled')));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      const request = pending.get(controlId);
      if (!request) return;
      pending.delete(controlId);
      cleanup();
      reject(new Error('remote agent control timed out'));
    }, 180_000);
    timer.unref?.();
    const sent = safeIpcSend(process, {
      type: 'agent-control',
      controlId,
      args: args && typeof args === 'object' ? args : {},
      context: {
        callerCwd: typeof context?.callerCwd === 'string' ? context.callerCwd : null,
        invocationSource: typeof context?.invocationSource === 'string'
          ? context.invocationSource
          : null,
        callerSessionId: typeof context?.callerSessionId === 'string'
          ? context.callerSessionId
          : null,
        clientHostPid: Number(context?.clientHostPid) || null,
      },
    }, {
      onError: (error) => {
        const request = pending.get(controlId);
        if (!request) return;
        pending.delete(controlId);
        cleanup();
        reject(error);
      },
    });
    if (!sent) {
      const request = pending.get(controlId);
      if (request) {
        pending.delete(controlId);
        cleanup();
        reject(new Error('runtime shard IPC is unavailable'));
      }
    }
  });
}
