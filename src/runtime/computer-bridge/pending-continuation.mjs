function payload(value) {
  try { return JSON.parse(value?.text || '{}'); } catch { return {}; }
}

export function isPendingComputerWork(value) {
  const result = payload(value);
  return result.status === 'paused' && result.code === 'computer_user_intervention_pending';
}

/** Keep the agent's tool call pending; only read-only waits/captures are sent.
 * The original mutation is never submitted again. The agent receives fresh
 * evidence and progress, then decides how to fulfill the remaining intent. */
export async function continuePendingComputerWork(initial, command, send, signal) {
  const progress = payload(initial);
  for (;;) {
    signal?.throwIfAborted();
    try {
    const waited = payload(await send({ action: 'wait_for_user', timeout_ms: 60_000 }));
    signal?.throwIfAborted();
    if (waited.status === 'timeout' && ['user_input_active', 'user_pause'].includes(waited.reason)) continue;
    if (waited.status !== 'resumed' || waited.resumed !== true) {
      return { text: JSON.stringify({
        ...progress, ok: false, status: waited.status === 'cancelled' ? 'cancelled' : 'paused',
        reason: waited.reason || 'resume_unconfirmed', input_replayed: false,
        recovery: { next: 'wait_for_user', guidance: 'Work has not completed. Resume was not confirmed; no input was replayed.' },
      }) };
    }
    const target = command.window_id ? { window_id: command.window_id }
      : command.app ? { app: command.app } : command.window ? { window: command.window } : null;
    if (!target) {
      return { text: JSON.stringify({ ...progress, status: 'resumed', fresh_capture_required: true,
        recovery: { next: 'capture', guidance: 'User control ended. Capture the intended target, then continue remaining intent without replaying completed or uncertain input.' } }) };
    }
    const captured = await send({ action: 'capture', ...target });
    if (isPendingComputerWork(captured)) continue;
    const observation = payload(captured);
    return { ...captured, text: JSON.stringify({
      ...progress, ok: observation.ok === true, status: 'resumed', reason: '',
      observation, input_replayed: false, fresh_capture_required: observation.ok !== true,
      recovery: { next: observation.ok === true ? 'continue_pending_work' : 'capture',
        guidance: 'Continue the remaining intent from this fresh observation. Completed or uncertain input must not be replayed blindly.' },
    }) };
    } catch {
      signal?.throwIfAborted();
      return { text: JSON.stringify({
        ...progress, ok: false, status: 'paused', code: 'computer_pending_read_failed',
        input_replayed: false, fresh_capture_required: true,
        recovery: { next: 'wait_for_user',
          guidance: 'Read-only continuation failed. Pending work is retained. Restore connection/control, then capture fresh state; never replay completed or uncertain input.' },
      }) };
    }
  }
}
