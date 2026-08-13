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

/** Keep the draft cover for the first promoted session, even after settle. */
export function nextConversationCoverId(
  previousCoverId: string,
  sessionId: string,
  surfaceSettled: boolean,
  originSessionId = "",
): string {
  const nextId = String(sessionId || "").trim() || "draft";
  const previous = String(previousCoverId || "").trim() || "draft";
  const origin = String(originSessionId || "").trim();
  if (previous === "draft") {
    // First promotion keeps the draft cover after settle. A later switch to a
    // different session leaves draft so session-to-session still covers.
    if (nextId === "draft") return "draft";
    if (!origin || origin === nextId) return "draft";
    return nextId;
  }
  if (nextId !== "draft" && !surfaceSettled) return previous;
  return nextId;
}

/** Remember the session this draft promoted into until the pane leaves it. */
export function nextConversationOriginSessionId(
  originSessionId: string,
  sessionId: string,
): string {
  const nextId = String(sessionId || "").trim();
  if (!nextId) return "";
  const origin = String(originSessionId || "").trim();
  return origin || nextId;
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
  return Boolean(coverId) && coverId !== "draft";
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
  if (hidden || promotingFromDraft || incoming === "draft" || held === "draft") {
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
