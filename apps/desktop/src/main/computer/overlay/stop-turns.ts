/** Turn cancellation is independent of native input cleanup. A failed or late
 * daemon reply must neither delay that cleanup nor silently reopen input. */
export async function confirmComputerTurnsStopped(
  sessionIds: string[],
  abortSession: (sessionId: string) => Promise<unknown>,
  timeoutMs = 10_000,
): Promise<void> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(sessionIds.map(async sessionId => abortSession(sessionId))),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(
          'computer_stop_unconfirmed: agent turn cancellation timed out; input remains paused',
        )), timeoutMs);
      }),
    ]);
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('computer_stop_unconfirmed: agent turn cancellation failed; input remains paused');
    }
  } finally {
    clearTimeout(deadline);
  }
}
