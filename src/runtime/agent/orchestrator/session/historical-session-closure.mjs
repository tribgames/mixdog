// Named sessions no longer receive automatic tombstones. Ownerless legacy
// records still follow idle retention, so their closures are not historical.
export function isHistoricalAutomaticClosure(session) {
  return (
    typeof session?.owner === 'string' &&
    session.owner.length > 0 &&
    (session?.closed === true || session?.status === 'closed') &&
    (session.closedReason === 'idle-sweep' || session.closedReason === 'terminal-reap')
  );
}
