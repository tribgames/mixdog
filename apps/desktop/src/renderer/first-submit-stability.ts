/** Draft → first session must not change the conversation cover key. */
export function conversationCoverIdentity(
  previousCoverId: string,
  sessionId: string,
  surfaceSettled = false
): { coverKey: string; promotingFromDraft: boolean } {
  const nextId = String(sessionId || '').trim();
  if (!nextId) return { coverKey: 'draft', promotingFromDraft: false };
  if (!previousCoverId || previousCoverId === 'draft') {
    return { coverKey: 'draft', promotingFromDraft: !surfaceSettled };
  }
  return { coverKey: nextId, promotingFromDraft: false };
}

/** Only a draft that submitted its first prompt is promoted into the session
 *  it created. Opening an existing session from New Task is a plain session
 *  entry: treated as a promotion, it skipped the cover and left the New Task
 *  watermark on screen until the cold lane landed, then popped the rows in
 *  (user: 세션 로딩할 때 투툭 튀고 이전 게 잔상으로 남는다). */
export function conversationDraftPromotion(
  draftSubmitted: boolean,
  originSessionId: string,
  sessionId: string
): boolean {
  const origin = String(originSessionId || '').trim();
  return draftSubmitted && (!origin || origin === String(sessionId || '').trim());
}

/** The cover id a render judges against: a draft that did not promote enters
 *  its session like any session-to-session switch. */
export function conversationCoverBasis(coverId: string, sessionId: string, draftPromotion: boolean): string {
  const previous = String(coverId || '').trim() || 'draft';
  if (previous !== 'draft' || draftPromotion) return previous;
  return String(sessionId || '').trim() || 'draft';
}

/** Keep the draft cover for the first promoted session, even after settle. */
export function nextConversationCoverId(
  previousCoverId: string,
  sessionId: string,
  surfaceSettled: boolean,
  draftPromotion = false
): string {
  const nextId = String(sessionId || '').trim() || 'draft';
  const previous = String(previousCoverId || '').trim() || 'draft';
  // First promotion keeps the draft cover after settle. Any other entry from
  // draft leaves it so the session still covers.
  if (previous === 'draft') return draftPromotion ? 'draft' : nextId;
  if (nextId !== 'draft' && !surfaceSettled) return previous;
  return nextId;
}

/** Remember the session this draft promoted into until the pane leaves it. */
export function nextConversationOriginSessionId(originSessionId: string, sessionId: string): string {
  const nextId = String(sessionId || '').trim();
  if (!nextId) return '';
  const origin = String(originSessionId || '').trim();
  return origin || nextId;
}

/** A loaded lane with no rows has no transcript to reveal, so its entry has
 *  nothing to wait for (the timeline never reveals an empty list). */
export function conversationLaneIsEmpty(
  lane: { items?: readonly unknown[]; streamingTail?: unknown } | null | undefined
): boolean {
  if (!lane) return false;
  return !(Array.isArray(lane.items) && lane.items.length > 0) && !lane.streamingTail;
}

/** First-promoted lanes already painted as New Task. Markdown readiness must
 *  not unmount that timeline or replay the conversation cover. */
export function conversationMarkdownPending({
  transcriptPending,
  coverId,
  hasMeasurements,
}: {
  transcriptPending: boolean;
  coverId: string;
  hasMeasurements: boolean;
}): boolean {
  if (!transcriptPending || hasMeasurements) return false;
  return Boolean(coverId) && coverId !== 'draft';
}

/** Session-to-session pane registration stays covered until the incoming
 *  lane can paint. Draft promotion and New Task never take this hold. */
export function conversationSwitchPaintGate(
  heldId: string,
  incomingId: string,
  {
    hidden = false,
    promotingFromDraft = false,
    contentReady = false,
    preparedBeforeSwitch = false,
  }: {
    hidden?: boolean;
    promotingFromDraft?: boolean;
    contentReady?: boolean;
    preparedBeforeSwitch?: boolean;
  } = {}
): { adoptNow: boolean; reveal: boolean } {
  const incoming = String(incomingId || '').trim() || 'draft';
  const held = String(heldId || '').trim() || 'draft';
  if (hidden || promotingFromDraft || incoming === 'draft') {
    return { adoptNow: true, reveal: true };
  }
  // A lane fetched before navigation already has its final transcript tree.
  // Adopt it from the layout effect before Chromium paints; the extra covered
  // rAF is only needed when readiness arrived after the route changed.
  if (contentReady && preparedBeforeSwitch) {
    return { adoptNow: true, reveal: true };
  }
  if (!contentReady) return { adoptNow: false, reveal: false };
  return { adoptNow: held === incoming, reveal: held === incoming };
}

/** Keep the outgoing session on the conversation until the incoming lane
 *  can mount the timeline in one commit. */
export function conversationPresentedSessionId(
  presentedId: string,
  incomingId: string,
  {
    hidden = false,
    promotingFromDraft = false,
    incomingReady = false,
  }: {
    hidden?: boolean;
    promotingFromDraft?: boolean;
    incomingReady?: boolean;
  } = {}
): string {
  const incoming = String(incomingId || '').trim();
  const presented = String(presentedId || '').trim();
  if (hidden || promotingFromDraft || !incoming) return incoming;
  if (!incomingReady) return presented || incoming;
  return incoming;
}

/** A single newest row appeared at the front; existing order is unchanged. */
export function sessionListInsertedAtTop(previousIds: readonly string[], nextIds: readonly string[]): boolean {
  if (nextIds.length !== previousIds.length + 1) return false;
  return nextIds.slice(1).every((id, index) => id === previousIds[index]);
}

export { sessionListKeepsExistingTopInsert } from '../shared/session-catalog';
