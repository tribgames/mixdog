/** A method deadline belongs to that call alone. Transport liveness is
 *  checked independently, so a slow operation cannot fail healthy siblings. */
export function armRemoteCallDeadline(
  pending: Pick<Map<number, unknown>, "delete">,
  id: number,
  reject: (error: Error) => void,
  probe: () => void,
  timers: Pick<Window, "setTimeout"> = window,
): number {
  return timers.setTimeout(() => {
    if (!pending.delete(id)) return;
    reject(new Error("mixdog remote call timed out."));
    probe();
  }, 20_000);
}
