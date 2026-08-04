function ipcUnavailableError() {
  return Object.assign(new Error('IPC channel unavailable'), {
    code: 'ERR_IPC_CHANNEL_CLOSED',
  });
}

export function safeIpcSend(proc, message, { onError, onComplete } = {}) {
  const report = (error) => {
    if (!error) return;
    try { onError?.(error); } catch {}
  };
  const complete = (error = null) => {
    try { onComplete?.(error); } catch {}
  };

  if (!proc || typeof proc.send !== 'function' || proc.connected !== true) {
    const error = ipcUnavailableError();
    report(error);
    complete(error);
    return false;
  }

  try {
    proc.send(message, undefined, {}, (error) => {
      report(error);
      complete(error || null);
    });
    return true;
  } catch (error) {
    report(error);
    complete(error);
    return false;
  }
}
