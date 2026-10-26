// An approval answered on ANOTHER device leaves this one with a card that
// simply vanishes. Keep a settled card on screen briefly that says who answered.
import { useEffect, useRef, useState } from 'react';
import type { Approval, Snapshot } from './desktop-types';

export const RETIRED_APPROVAL_MS = 6_000;

export interface RetiredApproval {
  approval: Approval;
  outcome: { approved: boolean; device: string; expired?: boolean };
}

/** The settled card to show for `previous` once it left the snapshot, or null
 *  when this device answered it itself. Whether the answerer is another device
 *  than the viewer is decided against the viewer's name (isOtherDevice); the
 *  transcript's user rows say nothing about who answered an approval. */
export function retiredApprovalFor(
  previous: Approval,
  snapshot: Pick<Snapshot, 'toolApproval' | 'toolApprovalResult' | 'items'>,
  decidedLocally: ReadonlySet<string>
): RetiredApproval | null {
  // A question's end (answered elsewhere, timed out) leaves no card or line.
  if (previous.kind === 'question') return null;
  const result = snapshot.toolApprovalResult;
  const id = String(previous.id ?? '');
  if (snapshot.toolApproval || !result || String(result.id) !== id) return null;
  // A real timeout names nobody; withdrawn / interrupted ends show nothing.
  if (!result.device)
    return result.expired === true
      ? { approval: previous, outcome: { approved: false, device: '', expired: true } }
      : null;
  if (decidedLocally.has(id)) return null;
  return { approval: previous, outcome: { approved: result.approved === true, device: result.device } };
}

export function useRetiredApproval(snapshot: Snapshot, decidedLocally: ReadonlySet<string>): RetiredApproval | null {
  const lastPending = useRef<Approval | null>(null);
  const [retired, setRetired] = useState<RetiredApproval | null>(null);
  useEffect(() => {
    if (snapshot.toolApproval) {
      lastPending.current = snapshot.toolApproval;
      setRetired(null);
      return;
    }
    const previous = lastPending.current;
    if (!previous) return;
    lastPending.current = null;
    const next = retiredApprovalFor(previous, snapshot, decidedLocally);
    if (!next) return;
    setRetired(next);
  }, [snapshot, decidedLocally]);
  useEffect(() => {
    if (!retired) return;
    const timer = window.setTimeout(() => setRetired(null), RETIRED_APPROVAL_MS);
    return () => window.clearTimeout(timer);
  }, [retired]);
  return retired;
}
