// An approval answered on ANOTHER device leaves this one with a card that
// simply vanishes. When the conversation involves more than one device, keep a
// settled card on screen briefly that says who answered.
import { useEffect, useRef, useState } from 'react';
import { sessionUsesMultipleDevices } from '../shared/session-devices';
import type { Approval, Snapshot } from './desktop-types';

const RETIRED_APPROVAL_MS = 6_000;

export interface RetiredApproval {
  approval: Approval;
  outcome: { approved: boolean; device: string };
}

/** The settled card to show for `previous` once it left the snapshot, or null
 *  when this device answered it itself or only one device is involved. */
export function retiredApprovalFor(
  previous: Approval,
  snapshot: Pick<Snapshot, 'toolApproval' | 'toolApprovalResult' | 'items'>,
  decidedLocally: ReadonlySet<string>
): RetiredApproval | null {
  const result = snapshot.toolApprovalResult;
  const id = String(previous.id ?? '');
  if (snapshot.toolApproval || !result || !result.device || String(result.id) !== id) return null;
  if (decidedLocally.has(id)) return null;
  if (!sessionUsesMultipleDevices(snapshot.items, [result.device])) return null;
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
