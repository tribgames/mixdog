// The host can replace its Office application while keeping the transport alive. Track identity
// before settling a response, so an immediate cancellation/exit cleans up the current process.
export const sessionClients = new Map();

export function officeCleanupError(message, cleanup) {
  if (!cleanup || cleanup.ok) return message;
  return `${message}; cleanup unconfirmed: ${cleanup.error || cleanup.errors?.join('; ') || 'Office host did not report a clean exit'}`;
}

export function acceptSessionIdentity(client, message) {
  if (message.session !== client.sessionId) return;
  if (!client.ownership && message.ok === true && ['owned', 'attached'].includes(message.ownership)) {
    client.ownership = message.ownership;
  }
  if (typeof message.ownsApplication === 'boolean') client.ownsApplication = message.ownsApplication;
  if (Number.isSafeInteger(message.appPid) && message.appPid >= 0) {
    client.appPid = message.appPid;
  }
  if (message.cleanup?.processExited === true) client.appPid = 0;
  if (message.cleanup?.applicationRetained === true) client.ownsApplication = false;
}

export function stopSessionClient(client, error = '', {
  clients = sessionClients,
  forceHost = false,
} = {}) {
  if (!client || client.closed) return;
  client.closed = true;
  clients.delete(client.sessionId);
  const failure = {
    ok: false,
    backend: 'microsoft-office-com',
    error: error || 'Microsoft Office session host stopped',
  };
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve(failure);
  }
  client.pending.clear();
  try { client.child.stdin.end(); } catch {}
  // EOF runs the host's verified document cleanup, including an open that has
  // not answered yet. Killing its process here bypasses finally and orphans COM.
  if (forceHost) { try { client.child.kill(); } catch {} }
  if (forceHost || client.child?.exitCode != null) { try { client.readline.close(); } catch {} }
}

export async function drainSessionClient(client, error = '', { graceMs = 15_000 } = {}) {
  if (!client) return { ok: true, hostExited: true };
  if (client.cleanupPromise) return client.cleanupPromise;
  client.closing = true;
  client.cleanupPromise = (async () => {
    let timer;
    let onClose;
    client.child.ref?.();
    const exited = client.child.exitCode != null || await new Promise((resolve) => {
      onClose = () => resolve(true);
      client.child.once('close', onClose);
      timer = setTimeout(() => resolve(false), graceMs);
      try { client.child.stdin.end(); } catch { resolve(false); }
    });
    clearTimeout(timer);
    if (onClose) client.child.removeListener('close', onClose);
    client.child.unref?.();
    const failures = String(client.stderr || '').split(/\r?\n/).filter((line) => line.includes('MIXDOG_OFFICE_CLEANUP'));
    if (!exited) {
      // No evidence that a shared/user document is safe to kill. The host keeps
      // its EOF request and will clean up when the in-flight COM call returns.
      client.child.stdout?.unref?.();
      client.child.stderr?.unref?.();
      return { ok: false, hostExited: false, pending: true, error: 'Office cleanup is still pending; the host was not force-killed.' };
    }
    stopSessionClient(client, error);
    return {
      ok: failures.length === 0 && (client.child.exitCode === 0 || client.child.exitCode == null),
      hostExited: true,
      ...(failures.length ? { errors: failures } : {}),
    };
  })();
  return client.cleanupPromise;
}

export function stopMicrosoftOfficeSessionClients(
  clients = sessionClients,
  error = 'Microsoft Office session host stopped',
  options = {},
) {
  for (const client of [...clients.values()]) {
    stopSessionClient(client, error, { ...options, clients });
  }
  clients.clear();
}
