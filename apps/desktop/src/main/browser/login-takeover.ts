/**
 * Pure rules of the sign-in window (login-popup.ts): which takeover asks for
 * it, which pages it may show, which sites end it by themselves, where it
 * sits, and when the agent's page may reload after a sign-in.
 */
import type { WebContents } from 'electron';

import type { DesktopBrowserLoginStatus } from '../../shared/contract';
import type { BrowserNetworkLedger } from './network';
import { isLoopbackHostname, normalizePageUrl, type BrowserUrlPolicy } from './url-policy';

/** The login takeover (ask_user handoff purpose 'login') a session snapshot
 *  waits on, or null: every other takeover keeps the side panel. */
export function loginTakeoverOf(snapshot: unknown): { id: string; url: string; tab: string } | null {
  const approval = (snapshot as { toolApproval?: Record<string, unknown> | null } | null)?.toolApproval;
  const takeover = approval?.kind === 'takeover' ? (approval.takeover as Record<string, unknown> | null) : null;
  if (takeover?.surface !== 'browser' || takeover.purpose !== 'login' || typeof takeover.url !== 'string') return null;
  return {
    id: String(approval?.id ?? 'takeover'),
    url: takeover.url,
    tab: typeof takeover.tab === 'string' ? takeover.tab : '',
  };
}

/** A page the sign-in window may show: the Browser Use URL policy, and HTTPS
 *  except on loopback (a local site). Throws otherwise. */
export function loginNavigationUrl(raw: string, policy: BrowserUrlPolicy): string {
  const href = normalizePageUrl(raw, policy);
  const url = new URL(href);
  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    throw new Error(`Sign-in pages must use HTTPS: ${url.host}`);
  }
  return href;
}

/** A site whose signed-in state its navigation alone shows: the window then
 *  closes by itself as done. Only explicit, trusted rules; none ship yet. */
export interface LoginAutoCloseRule {
  host: string;
  signedIn(url: URL): boolean;
}
export const LOGIN_AUTO_CLOSE_RULES: readonly LoginAutoCloseRule[] = [];

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function loginAutoClose(rawUrl: string, rules: readonly LoginAutoCloseRule[]): boolean {
  const url = parseUrl(rawUrl);
  return Boolean(
    url && url.protocol === 'https:' && rules.some((rule) => rule.host === url.hostname && rule.signedIn(url))
  );
}

/** Providers that refuse sign-in inside an embedded browser, by the page they
 *  send it to (Google: "This browser or app may not be secure"). */
const LOGIN_REFUSALS = [{ host: 'accounts.google.com', path: /\/signin\/(?:v\d\/)?rejected\b/, provider: 'Google' }];

/** The provider refusing embedded sign-in at `rawUrl`, else ''. */
export function loginRefusal(rawUrl: string): string {
  const url = parseUrl(rawUrl);
  return LOGIN_REFUSALS.find((rule) => url?.hostname === rule.host && rule.path.test(url.pathname))?.provider ?? '';
}

export type BrowserLoginStatus = DesktopBrowserLoginStatus;

/** About 480×720, centred on the Mixdog window and kept inside the work area. */
export function loginPopupBounds(
  parent: Electron.Rectangle | null,
  workArea: Electron.Rectangle,
  size = { width: 480, height: 720 }
): Electron.Rectangle {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const center = parent
    ? { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 }
    : { x: workArea.x + workArea.width / 2, y: workArea.y + workArea.height / 2 };
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  return {
    x: clamp(Math.round(center.x - width / 2), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(center.y - height / 2), workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

/** The agent's page reloads after a sign-in only when nothing would be lost:
 *  no input a person made, no edited form field, and a document fetched by GET
 *  (a reload would resend a POST). An unknown method is not safe. */
export function safeToReloadAfterSignIn(page: {
  userInput: boolean;
  editedFields: boolean;
  documentMethod: string;
}): boolean {
  return !page.userInput && !page.editedFields && page.documentMethod.toUpperCase() === 'GET';
}

/** Reloads the agent's page after a sign-in when that is safe; true when it did. */
export async function reloadPageAfterSignIn(
  guest: WebContents | null,
  record: { userInput: boolean; network: BrowserNetworkLedger } | undefined
): Promise<boolean> {
  if (!guest || guest.isDestroyed()) return false;
  const address = guest.getURL().split('#', 1)[0];
  // The ledger lists newest first: the request behind the current document.
  const document = record?.network
    .list({ resourceTypes: ['document'], limit: 200 })
    .requests.find((request) => request.sessionId === undefined && request.url.split('#', 1)[0] === address);
  const editedFields = await guest
    .executeJavaScriptInIsolatedWorld(EDITED_FIELDS_WORLD, [{ code: EDITED_FIELDS_SCRIPT }])
    .then(
      (edited) => edited !== false,
      () => true
    );
  if (
    !safeToReloadAfterSignIn({
      userInput: record?.userInput === true,
      editedFields,
      documentMethod: document?.method ?? '',
    })
  ) {
    return false;
  }
  guest.reload();
  return true;
}

const EDITED_FIELDS_WORLD = 1_197;

/** Script for an isolated world of the agent's page: any form field whose
 *  value differs from what the document loaded with. */
const EDITED_FIELDS_SCRIPT = `(() => {
  for (const field of document.querySelectorAll('input, textarea, select')) {
    if (field instanceof HTMLSelectElement) {
      if ([...field.options].some((option) => option.selected !== option.defaultSelected)) return true;
    } else if (field.type === 'checkbox' || field.type === 'radio') {
      if (field.checked !== field.defaultChecked) return true;
    } else if (!['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(field.type) && field.value !== field.defaultValue) {
      return true;
    }
  }
  return false;
})()`;
