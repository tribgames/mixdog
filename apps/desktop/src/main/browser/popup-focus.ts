/** Whether a window a page opened becomes the session's selected tab. Chrome
 *  brings a window opened in front (a `target=_blank` link, `window.open`)
 *  forward and leaves one opened behind (Ctrl or middle click) where it is.
 *  Here the window must also come from a current gesture of the person:
 *   - the opener's last actor is the person, not an agent command (an agent
 *     click through CDP carries a user activation too), and
 *   - Chromium reports a user gesture for this very window (Page.windowOpen:
 *     the opener frame's transient activation, which opening a window
 *     consumes), or the person answered a dialog of the opener just before
 *     (`alert(); window.open()`: reading the alert can outlast Chromium's
 *     activation window).
 *  A window the page opens later from a timer has neither, so it stays
 *  behind; agent-opened popups stay unselected and are reported instead. */
export type PageActor = 'person' | 'agent';

/** How soon after the person answered a dialog a window still counts as theirs. */
export const DIALOG_ANSWER_GESTURE_MS = 1_000;
/** A Page.windowOpen event older than this belongs to no window being opened now. */
const WINDOW_OPEN_MATCH_MS = 2_000;
const WINDOW_OPEN_LIMIT = 8;

export interface WindowOpenGesture {
  url: string;
  userGesture: boolean;
  at: number;
}

export interface PopupOpenEvidence {
  actor: PageActor | undefined;
  /** Chromium's gesture for this window (`takeWindowOpenGesture`). */
  userGesture: boolean;
  personDialogAnswerAt?: number;
  now: number;
}

/** `disposition`: Electron's window-open disposition for the new window. */
export function popupTakesSelection(disposition: string, evidence: PopupOpenEvidence): boolean {
  if (evidence.actor !== 'person') return false;
  if (disposition !== 'foreground-tab' && disposition !== 'new-window') return false;
  if (evidence.userGesture) return true;
  const answered = evidence.personDialogAnswerAt;
  return answered !== undefined && evidence.now - answered >= 0 && evidence.now - answered <= DIALOG_ANSWER_GESTURE_MS;
}

/** window.open('') reaches CDP without an address and Electron as about:blank. */
const openUrl = (url: string) => url || 'about:blank';

/** Keep a Page.windowOpen report (from any frame of the opener). */
export function recordWindowOpen(
  record: { windowOpens: WindowOpenGesture[] },
  event: { url?: unknown; userGesture?: unknown },
  now = Date.now()
): void {
  record.windowOpens.push({ url: openUrl(String(event.url || '')), userGesture: event.userGesture === true, at: now });
  if (record.windowOpens.length > WINDOW_OPEN_LIMIT) record.windowOpens.shift();
}

/** The gesture Chromium reported for the window opening at `url`, used once.
 *  Chromium sends Page.windowOpen before Electron asks for the window
 *  (measured on Electron 41); no matching report counts as no gesture. */
export function takeWindowOpenGesture(
  record: { windowOpens: WindowOpenGesture[] } | undefined,
  url: string,
  now = Date.now()
): boolean {
  if (!record) return false;
  record.windowOpens = record.windowOpens.filter((entry) => now - entry.at <= WINDOW_OPEN_MATCH_MS);
  const wanted = openUrl(url);
  let index = record.windowOpens.length - 1;
  while (index >= 0 && record.windowOpens[index].url !== wanted) index--;
  if (index < 0) return false;
  const [entry] = record.windowOpens.splice(index, 1);
  return entry.userGesture;
}
