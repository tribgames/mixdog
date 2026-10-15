// /btw side question: one transient card per session surface. The state flow
// lives here, free of React, so the Composer only subscribes and paints.
// Nothing is written to the transcript.
export type BtwCardState = {
  question: string;
  status: 'pending' | 'answered' | 'failed';
  text: string;
  error: string;
};

type BtwInvoke = (request: {
  capability: 'askSide' | 'cancelSide';
  sessionId: string;
  args?: unknown[];
}) => Promise<unknown>;

// The runtime replies like every capability ({ value }); a bare { text } is
// read the same way.
function answerText(result: unknown): string {
  const record = (result ?? {}) as { text?: unknown; value?: { text?: unknown } };
  const text = record.value?.text ?? record.text;
  return typeof text === 'string' ? text : '';
}

export function createBtwController(invoke: BtwInvoke, onChange: (state: BtwCardState | null) => void) {
  let state: BtwCardState | null = null;
  let ticket = 0;
  let pendingSession = '';
  const publish = (next: BtwCardState | null) => {
    state = next;
    onChange(next);
  };
  const cancelPending = () => {
    ticket += 1;
    if (state?.status !== 'pending') return;
    // The late result is dropped by the ticket; a failed cancel changes nothing here.
    void Promise.resolve(invoke({ capability: 'cancelSide', sessionId: pendingSession })).catch(() => undefined);
  };
  const ask = (sessionId: string, question: string) => {
    cancelPending();
    const mine = ticket;
    pendingSession = sessionId;
    publish({ question, status: 'pending', text: '', error: '' });
    return Promise.resolve(invoke({ capability: 'askSide', sessionId, args: [question] })).then(
      (result) => {
        if (mine === ticket) publish({ question, status: 'answered', text: answerText(result), error: '' });
      },
      (error: unknown) => {
        if (mine !== ticket) return;
        const message = error instanceof Error ? error.message : String(error);
        publish({ question, status: 'failed', text: '', error: message });
      }
    );
  };
  return {
    ask,
    /** Re-sends the open card's question. */
    retry: (sessionId: string) => (state ? ask(sessionId, state.question) : Promise.resolve()),
    /** Close or cancel: cancels a pending ask, drops any late result. */
    close: () => {
      cancelPending();
      if (state) publish(null);
    },
    current: () => state,
  };
}
