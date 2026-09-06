/** Abort the wait, not the cleanup. A late cleanup can never authorize resume. */
export async function waitForResumeBarrier(work: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(10_000);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (cancellation.aborted) {
    void work.catch(() => {});
    throw new Error('computer_resume_cancelled: resume request expired');
  }
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error('computer_resume_cancelled: cleanup or command completion is still pending'));
    cancellation.addEventListener('abort', abort, { once: true });
    work.then(() => {
      cancellation.removeEventListener('abort', abort);
      if (cancellation.aborted) abort(); else resolve();
    }, (error) => {
      cancellation.removeEventListener('abort', abort);
      reject(error);
    });
  });
}
