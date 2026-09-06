/** Only new-task requests with a stable, durable creation receipt may be
 * replayed here. Arbitrary mutations must never inherit this retry policy. */
export async function recoverableCreation<T>(
  submit: () => Promise<T>,
  recover: () => Promise<void>,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const budget = options.budgetMs ?? 120_000;
  const deadline = now() + budget;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const interrupted = (error: unknown) => {
    const failure = error as { code?: string; message?: string };
    return failure?.code === 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED'
      || failure?.message === 'mixdog remote call timed out.';
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('New task acknowledgement timed out. Your message is retained for retry.'));
    }, budget);
  });
  const run = async (): Promise<T> => {
    for (;;) {
      if (expired) throw new Error('New task recovery expired.');
      try { return await submit(); } catch (error) {
        if (!interrupted(error) || now() >= deadline) throw error;
        try { await recover(); } catch (recoveryError) {
          if (!interrupted(recoveryError)) throw recoveryError;
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  };
  try { return await Promise.race([run(), timeout]); } finally { clearTimeout(timer!); }
}
