/** Draft → first session must not change the conversation cover key. */
export function conversationCoverIdentity(
  previousCoverId: string,
  sessionId: string,
  surfaceSettled = false,
): { coverKey: string; promotingFromDraft: boolean } {
  const nextId = String(sessionId || "").trim();
  if (!nextId) return { coverKey: "draft", promotingFromDraft: false };
  if (!previousCoverId || previousCoverId === "draft") {
    return { coverKey: "draft", promotingFromDraft: !surfaceSettled };
  }
  return { coverKey: nextId, promotingFromDraft: false };
}

/** Hold the draft cover id until the promoted lane can stay revealed. */
export function nextConversationCoverId(
  previousCoverId: string,
  sessionId: string,
  surfaceSettled: boolean,
): string {
  const nextId = String(sessionId || "").trim() || "draft";
  if ((!previousCoverId || previousCoverId === "draft") && nextId !== "draft" && !surfaceSettled) {
    return previousCoverId || "draft";
  }
  return nextId;
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
  }: {
    hidden?: boolean;
    promotingFromDraft?: boolean;
    contentReady?: boolean;
  } = {},
): { adoptNow: boolean; reveal: boolean } {
  const incoming = String(incomingId || "").trim() || "draft";
  const held = String(heldId || "").trim() || "draft";
  if (hidden || promotingFromDraft || incoming === "draft") {
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
  } = {},
): string {
  const incoming = String(incomingId || "").trim();
  const presented = String(presentedId || "").trim();
  if (hidden || promotingFromDraft || !incoming) return incoming;
  if (!incomingReady) return presented || incoming;
  return incoming;
}

/** A single newest row appeared at the front; existing order is unchanged. */
export function sessionListInsertedAtTop(
  previousIds: readonly string[],
  nextIds: readonly string[],
): boolean {
  if (nextIds.length !== previousIds.length + 1) return false;
  return nextIds.slice(1).every((id, index) => id === previousIds[index]);
}

export { sessionListKeepsExistingTopInsert } from "../shared/session-catalog";
