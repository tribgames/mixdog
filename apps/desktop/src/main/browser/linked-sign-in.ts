/**
 * Linked sign-in memory: which identity provider (and, when the agent named
 * it there, which account) Browser Use last signed in to a site with —
 * "Continue with Google / Apple / X / Kakao / …", any provider alike.
 *
 * Detection is by protocol only. A main-frame navigation that site S's page
 * (the tab's main frame, on S) starts towards another registrable domain —
 * directly or through S's own auth servers' redirects — with an OAuth 2 / OIDC authorization
 * request (`client_id` with `redirect_uri` or `response_type`) or an OAuth
 * 1.0a one (`oauth_token` on an authorize / authenticate path), possibly
 * inside the provider's own `continue` / `return_to` / `next` address, is
 * remembered for that tab with its `state` or `oauth_token`; one with neither
 * is ignored. The sign-in is complete when a navigation of the same tab
 * reaches the redirect_uri (or S, with none given) carrying that same state
 * with a code / id_token / access_token — in the query, the fragment or a
 * form_post body — or that same oauth_token with an oauth_verifier, no
 * error, arriving from the provider (a server redirect off its domain, or a
 * navigation this tab's main frame on the provider's origin started), and
 * that navigation commits below HTTP 400 back on S. A request with no S page
 * behind it (a popup, an address the agent sent) records nothing: the site is
 * never taken from a callback or redirect_uri.
 *
 * The record keeps S (its registrable domain), the redirect host, the
 * provider's registrable domain, and the account only when the agent itself
 * named one on the provider's pages in that flow: the accessible name of what
 * it clicked when that holds exactly one email address or @handle, or a value
 * of that form it typed into an input that positively is an account
 * identifier (`identifierField`). Nothing else — no code, token, state, URL
 * parameter or page text — is kept or read; a form_post body is read only
 * for a callback an open request waits for, in memory, up to 64 KiB.
 *
 * A reply for a page on a recorded site — or for the record's provider page
 * while this tab has a verified request open from that site — carries one
 * `Linked sign-in:` line, once per page per turn. URL parameters never pick it.
 */
import { createHash } from 'node:crypto';
import type { WebContents, WebFrameMain } from 'electron';
import { getDomain } from 'tldts';

import { linkedProviderLabel } from '../../shared/linked-sign-in-label';

/** One remembered federated sign-in: never a token, code or state. */
export interface LinkedSignIn {
  /** 24-hex row id from the site and the provider (one record per pair). */
  id: string;
  /** Registrable domain of the site signed in to. */
  site: string;
  /** Exact host the provider sent the sign-in back to. */
  redirectHost: string;
  /** The identity provider's registrable domain (google.com, apple.com, x.com…). */
  provider: string;
  /** The email or @handle the agent signed in as; '' when it named none. */
  identity: string;
  lastUsedAt: number;
}

export type LinkedSignInInput = Omit<LinkedSignIn, 'id' | 'lastUsedAt'>;

/** The frame of the same tab that started a navigation: its origin, and
 *  whether it is the tab's main frame. */
export interface NavigationInitiator {
  origin: string;
  main: boolean;
}

/** An input the agent types into, as the page itself declares it. */
export interface LinkedFieldFacts {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
}

/** Read on the input a ref names (Runtime.callFunctionOn): its own type,
 *  autocomplete, name and id; null for anything but an input. */
export const LINKED_FIELD_READ = `function() {
  const el = this;
  if (!el || String(el.tagName || '').toUpperCase() !== 'INPUT') return null;
  return {
    type: String(el.type || '').toLowerCase(),
    autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase(),
    name: String(el.getAttribute('name') || ''),
    id: String(el.id || ''),
  };
}`;

export const LINKED_SIGN_IN_PREFIX = 'Linked sign-in: ';
/** How long an authorization request waits for its callback (a 2-step check included). */
const FLOW_TTL_MS = 30 * 60_000;
const MAX_REQUESTS = 8;
const SHOWN_MEMORY = 500;
const MAX_BODY = 64 * 1024;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_ONLY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const HANDLE = /(?:^|[\s(])(@[A-Za-z0-9_]{1,30})(?![A-Za-z0-9_@.])/g;
const HANDLE_ONLY = /^@[A-Za-z0-9_]{1,30}$/;
/** An input's own name / id / autocomplete that says it holds an account. */
const IDENTIFIER_FIELD = /user|e-?mail|login|identifier|phone|account/i;
const IDENTIFIER_AUTOCOMPLETE = /(?:^|\s)(?:username|email|webauthn)(?:\s|$)/;

/** Whether the agent typed into an account identifier: the snapshot did not
 *  mark it secret (a password / protected input), it is no password input,
 *  and it positively declares an identifier — type=email, an autocomplete
 *  of username / email / webauthn, or a textbox whose own name, id or
 *  autocomplete names a user, email, login, identifier, phone or account. */
export function identifierField(ref: { role: string; sensitive?: boolean }, field: LinkedFieldFacts | null): boolean {
  if (!field || ref.sensitive || field.type === 'password' || field.type === 'hidden') return false;
  if (field.type === 'email' || IDENTIFIER_AUTOCOMPLETE.test(field.autocomplete)) return true;
  return (
    ref.role === 'textbox' &&
    ['text', 'tel', ''].includes(field.type) &&
    [field.name, field.id, field.autocomplete].some((value) => IDENTIFIER_FIELD.test(value))
  );
}

/** The registrable domain of `host` (public suffix list, private suffixes
 *  included); the host itself for IPs, localhost and the like. */
export function registrableHost(host: string): string {
  const value = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return getDomain(value, { allowPrivateDomains: true }) || value;
}

export function linkedSignInId(site: string, provider: string): string {
  return createHash('sha256').update(`${site}\0${provider}`).digest('hex').slice(0, 24);
}

/** A storable account: an email address or an @handle; '' otherwise. */
export function normalizeLinkedIdentity(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text.length <= 254 && EMAIL_ONLY.test(text)) || HANDLE_ONLY.test(text) ? text : '';
}

/** The one email address — else the one @handle — `text` names; '' for none or several. */
function namedIdentity(text: string): string {
  const unique = (found: string[]) => [...new Map(found.map((value) => [value.toLowerCase(), value])).values()];
  const emails = unique(text.match(EMAIL) ?? []);
  if (emails.length) return emails.length === 1 ? normalizeLinkedIdentity(emails[0]) : '';
  const handles = unique([...text.matchAll(HANDLE)].map((match) => match[1]));
  return handles.length === 1 ? handles[0] : '';
}

/** The reply line for `record`. */
export function linkedSignInLine(record: Pick<LinkedSignIn, 'site' | 'provider' | 'identity'>): string {
  const as = record.identity ? ` as ${record.identity}` : '';
  return `${LINKED_SIGN_IN_PREFIX}${record.site} last signed in with ${linkedProviderLabel(record.provider)}${as}`;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const siteOf = (url: URL): string => registrableHost(url.hostname);
const sameEndpoint = (a: URL, b: URL): boolean => a.origin === b.origin && a.pathname === b.pathname;

interface AuthorizationRequest {
  redirect: URL | null;
  /** OAuth 2 / OIDC: the state to come back; OAuth 1.0a: the request token. */
  state: string;
  oauthToken: string;
  /** response_mode=form_post: the callback comes as a posted form. */
  formPost: boolean;
}

/** The authorization request `url` carries — itself, or the provider's own
 *  `continue` / `return_to` / `next` address on its domain — when it has a
 *  value to come back (a state, an OAuth 1.0a token); null otherwise. */
export function authorizationRequest(url: URL): AuthorizationRequest | null {
  const visit = (at: URL, depth: number): AuthorizationRequest | null => {
    const params = at.searchParams;
    if (params.get('client_id') && (params.get('redirect_uri') || params.get('response_type'))) {
      const state = params.get('state') || '';
      const redirect = httpUrl(params.get('redirect_uri') || '');
      if (state) return { redirect, state, oauthToken: '', formPost: params.get('response_mode') === 'form_post' };
    } else if (params.get('oauth_token') && /\/(?:authorize|authenticate)(?:\/|$)/i.test(at.pathname)) {
      return { redirect: null, state: '', oauthToken: String(params.get('oauth_token')), formPost: false };
    }
    if (depth > 1) return null;
    for (const key of ['continue', 'return_to', 'next']) {
      const nested = params.get(key);
      if (!nested) continue;
      try {
        const inner = new URL(nested, at.origin);
        const found = siteOf(inner) === siteOf(url) ? visit(inner, depth + 1) : null;
        if (found) return found;
      } catch {
        /* not an address */
      }
    }
    return null;
  };
  return visit(url, 0);
}

interface Flow extends AuthorizationRequest {
  /** Host of site S's page whose own main frame started the request in this tab. */
  siteHost: string;
  provider: string;
  /** The account the agent named on the provider's pages. */
  identity: string;
  at: number;
}

interface Hop {
  url: URL;
  /** The address this hop left: the previous redirect, or the committed page. */
  from: string;
  /** The first hop only: the frame of this tab that started the navigation. */
  initiator: NavigationInitiator | null;
  /** A form_post body (a POST navigation's form fields). */
  body: URLSearchParams | null;
}

interface PageTrack {
  committed: string;
  hops: Hop[];
  flows: Flow[];
}

/** The values a callback carries: its query, its fragment and a posted form. */
function callbackParams(hop: Hop): URLSearchParams {
  const params = new URLSearchParams(hop.url.search);
  for (const [key, value] of new URLSearchParams(hop.url.hash.replace(/^#/, ''))) params.append(key, value);
  for (const [key, value] of hop.body ?? []) params.append(key, value);
  return params;
}

/** Electron-free flow tracking per tab `key`. */
export function createLinkedSignInTracker(now: () => number = Date.now) {
  const pages = new Map<unknown, PageTrack>();
  const track = (key: unknown): PageTrack => {
    let entry = pages.get(key);
    if (!entry) pages.set(key, (entry = { committed: '', hops: [], flows: [] }));
    entry.flows = entry.flows.filter((flow) => now() - flow.at <= FLOW_TTL_MS);
    return entry;
  };

  /** A hop onto `url` that is an authorization request: remembered for the tab. */
  const request = (entry: PageTrack, url: URL): void => {
    const found = authorizationRequest(url);
    if (!found) return;
    const provider = siteOf(url);
    // Only a request site S's own page started: the tab's main frame, on the
    // site of its committed page — never a popup with no page behind it, an
    // address the agent sent, another frame or another tab.
    const left = httpUrl(entry.committed);
    const initiator = entry.hops[0]?.initiator;
    const origin = httpUrl(initiator?.main ? initiator.origin : '');
    if (!left || !origin || siteOf(origin) !== siteOf(left)) return;
    // The provider's own pages passing the request along are no new request.
    if (siteOf(left) === provider) return;
    const same = (flow: Flow) =>
      flow.provider === provider && flow.state === found.state && flow.oauthToken === found.oauthToken;
    if (entry.flows.some(same)) return;
    entry.flows.push({ ...found, siteHost: left.hostname.toLowerCase(), provider, identity: '', at: now() });
    if (entry.flows.length > MAX_REQUESTS) entry.flows.shift();
  };

  /** Whether `hop` (the `index`th of its navigation) brings `flow` home. */
  const completes = (flow: Flow, hop: Hop, index: number): boolean => {
    if (flow.redirect ? !sameEndpoint(hop.url, flow.redirect) : siteOf(hop.url) !== registrableHost(flow.siteHost)) {
      return false;
    }
    const params = callbackParams(hop);
    if (params.has('error')) return false;
    const token = flow.state
      ? params.get('state') === flow.state && ['code', 'id_token', 'access_token'].some((name) => params.get(name))
      : params.get('oauth_token') === flow.oauthToken && Boolean(params.get('oauth_verifier'));
    if (!token) return false;
    // The provider sent it: a server redirect off its domain, or a navigation
    // a frame of this tab on its domain started.
    const from = httpUrl(hop.from);
    if (!from || siteOf(from) !== flow.provider) return false;
    if (index > 0) return true;
    const origin = httpUrl(hop.initiator?.main ? hop.initiator.origin : '');
    return Boolean(origin && siteOf(origin) === flow.provider);
  };

  /** Tab `key`'s main-frame navigation to `raw`: `start` (`initiator`: the
   *  frame of this tab that started it, if one did), `redirect` or `commit`
   *  (`failed`: an HTTP error answered). Returns the sign-in a commit
   *  completes, if any. */
  function navigation(
    key: unknown,
    raw: string,
    phase: 'start' | 'redirect' | 'commit',
    options: { initiator?: NavigationInitiator | null; failed?: boolean } = {}
  ): LinkedSignInInput | null {
    const entry = track(key);
    const url = httpUrl(raw);
    if (phase !== 'commit') {
      if (phase === 'start') entry.hops = [];
      if (!url) return null;
      const from = entry.hops.at(-1)?.url.href ?? entry.committed;
      entry.hops.push({ url, from, initiator: phase === 'start' ? (options.initiator ?? null) : null, body: null });
      request(entry, url);
      return null;
    }
    const hops = entry.hops;
    entry.hops = [];
    entry.committed = raw;
    if (!url || options.failed) return null;
    // The innermost request that came home (Google's inside a site's own
    // auth server) is the sign-in; the auth server's wrapping one is not.
    const done = entry.flows.filter((flow) => hops.some((hop, index) => completes(flow, hop, index)));
    const flow = done.at(-1);
    if (!flow) return null;
    const redirectHost = (flow.redirect ?? hops.find((hop, index) => completes(flow, hop, index))!.url).hostname.toLowerCase();
    entry.flows = entry.flows.filter((other) => !done.includes(other) && other.provider !== registrableHost(redirectHost));
    // Only S's sign-in, and only once it landed back on S in this tab: the
    // site is never taken from the callback or redirect_uri alone.
    const site = registrableHost(flow.siteHost);
    if (siteOf(url) !== site) return null;
    return { site, redirectHost, provider: flow.provider, identity: flow.identity };
  }

  /** The navigation of tab `key` now on `raw` is a POST an open form_post
   *  request waits for as its callback. */
  function expectsPost(key: unknown, raw: string): boolean {
    const url = httpUrl(raw);
    const entry = pages.get(key);
    return Boolean(
      url &&
        entry?.hops.at(-1)?.url.href === url.href &&
        entry.flows.some((flow) => flow.formPost && flow.redirect && sameEndpoint(url, flow.redirect))
    );
  }

  /** The form fields of that POST (a form_post callback). */
  function posted(key: unknown, raw: string, body: string): void {
    const hop = pages.get(key)?.hops.at(-1);
    if (hop?.url.href === raw) hop.body = new URLSearchParams(body);
  }

  /** The latest open request of tab `key` whose provider serves `url`. */
  const flowOn = (key: unknown, url: string): Flow | undefined => {
    const at = httpUrl(url);
    return at ? pages.get(key)?.flows.filter((flow) => flow.provider === siteOf(at)).at(-1) : undefined;
  };

  /** Whether tab `key` at `url` is on the provider's pages of an open request. */
  function onProvider(key: unknown, url: string): boolean {
    return Boolean(flowOn(key, url));
  }

  /** The agent named an account on the provider's page `url`: `text` is what
   *  it clicked (an accessible name) or typed into an identifier field. */
  function named(key: unknown, url: string, text: string, typed: boolean): void {
    const flow = flowOn(key, url);
    const identity = typed ? normalizeLinkedIdentity(text) : namedIdentity(text);
    if (flow && identity) flow.identity = identity;
  }

  /** The sites whose verified open requests in tab `key` (each started on
   *  that site's own page here) wait on `url`'s provider. */
  function flowSites(key: unknown, url: string): string[] {
    const at = httpUrl(url);
    const flows = at ? (pages.get(key)?.flows ?? []).filter((flow) => flow.provider === siteOf(at)) : [];
    return flows.map((flow) => registrableHost(flow.siteHost));
  }

  return {
    navigation,
    expectsPost,
    posted,
    onProvider,
    named,
    flowSites,
    forget: (key: unknown) => void pages.delete(key),
  };
}

/** The record a reply for `url` names. An ordinary page names only its own
 *  site's record (by its registrable domain). The provider's own page names
 *  another site's record only when it is that record's provider and the tab
 *  has a verified open request started on that site's page (`flowSites`,
 *  from the tab's tracker) — never from the address's parameters. The latest
 *  one wins. */
export function linkedSignInFor(
  records: readonly LinkedSignIn[],
  url: string,
  flowSites: readonly string[] = []
): LinkedSignIn | null {
  const page = httpUrl(url);
  if (!page || !records.length) return null;
  const site = siteOf(page);
  const matches = records.filter(
    (record) => record.site === site || (record.provider === site && flowSites.includes(record.site))
  );
  matches.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return matches[0] ?? null;
}

export interface BrowserLinkedSignInDeps {
  store: {
    list(): Promise<LinkedSignIn[]>;
    record(input: LinkedSignInInput): Promise<void>;
  };
  /** Snapshot ref `ref` of the page: its accessible name and role, whether
   *  the snapshot marked it secret, and the address the snapshot was taken
   *  on; null when unknown. */
  ref(guest: WebContents, ref: string): { name: string; url: string; role: string; sensitive?: boolean } | null;
  pageId(guest: WebContents): string;
  now?: () => number;
  onError?(error: unknown): void;
}

/** The frame that started a navigation of `guest`, when it is a frame of that
 *  same tab; null for the agent's own address, another tab or window (an
 *  opener, a popup) or a frame already gone. */
function initiatorOf(guest: WebContents, frame: WebFrameMain | null | undefined): NavigationInitiator | null {
  try {
    if (!frame || frame.isDestroyed()) return null;
    const main = guest.mainFrame.frameTreeNodeId;
    if ((frame.top ?? frame).frameTreeNodeId !== main) return null;
    return { origin: frame.origin, main: frame.frameTreeNodeId === main };
  } catch {
    return null;
  }
}

/** The host side: every tab's navigations and form_post bodies, the agent's
 *  clicks and typing on provider pages, and the reply line. */
export function createBrowserLinkedSignIns(deps: BrowserLinkedSignInDeps) {
  const tracker = createLinkedSignInTracker(deps.now);
  /** `${sessionId}\0${turnId}\0${pageId}\0${site}`: the line was given. */
  const shown = new Set<string>();
  const settle = (found: LinkedSignInInput | null): void => {
    if (found) void deps.store.record(found).catch((error) => deps.onError?.(error));
  };

  /** Follow one tab's main-frame navigations for the rest of its life. */
  function watch(guest: WebContents): void {
    const key = guest.id;
    guest.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      settle(tracker.navigation(key, details.url, 'start', { initiator: initiatorOf(guest, details.initiator) }));
    });
    guest.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame) settle(tracker.navigation(key, details.url, 'redirect'));
    });
    guest.on('did-navigate', (_event, url, httpResponseCode) =>
      settle(tracker.navigation(key, url, 'commit', { failed: httpResponseCode >= 400 }))
    );
    guest.once('destroyed', () => tracker.forget(key));
  }

  /** A main-frame POST of tab `webContentsId` (the partition's request hook).
   *  Only one an open form_post request waits for as its callback is read,
   *  and only up to MAX_BODY bytes, counted before anything is copied; its
   *  fields stay in memory for the state check, never kept. */
  function navigationPost(webContentsId: number, url: string, chunks: readonly Buffer[]): void {
    if (!tracker.expectsPost(webContentsId, url)) return;
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (size > MAX_BODY) return;
    tracker.posted(webContentsId, url, Buffer.concat(chunks.slice(), size).toString('utf8'));
  }

  /** Before an agent click or typing on a provider's page of an open request:
   *  the account it names — a clicked accessible name with exactly one email
   *  or @handle, or the value typed into an input that positively is an
   *  account identifier (`identifierField`, from the snapshot's secret flag
   *  and the input's own attributes as `readField` reads them). A ref counts
   *  only from a snapshot of this very page. Never fails the command. */
  async function beforeAction(
    guest: WebContents,
    action: string,
    command: { ref?: unknown; target?: unknown; text?: unknown; fields?: unknown },
    readField: (ref: string) => Promise<LinkedFieldFacts | null>
  ): Promise<void> {
    if (!['click', 'fill', 'type'].includes(action) || guest.isDestroyed()) return;
    const url = guest.getURL();
    if (!tracker.onProvider(guest.id, url)) return;
    const page = httpUrl(url);
    const refOf = (ref: unknown) => {
      const found = ref ? deps.ref(guest, String(ref)) : null;
      return found && page && httpUrl(found.url)?.origin === page.origin ? found : null;
    };
    if (action === 'click') {
      const ref = refOf(command.ref);
      if (ref) tracker.named(guest.id, url, ref.name, false);
      return;
    }
    const entries = Array.isArray(command.fields) ? command.fields : [{ ref: command.ref, text: command.text }];
    for (const entry of entries as Array<{ ref?: unknown; text?: unknown }>) {
      const ref = refOf(entry?.ref);
      if (!ref || typeof entry.text !== 'string') continue;
      const field = await readField(String(entry.ref)).catch(() => null);
      if (identifierField(ref, field)) tracker.named(guest.id, url, entry.text, true);
    }
  }

  /** The `Linked sign-in:` line for a reply on `guest`'s page, once per page
   *  and site per turn; '' when there is none to give. */
  async function replyLine(input: { guest: WebContents; sessionId: string; turnId: number }): Promise<string> {
    const { guest } = input;
    if (guest.isDestroyed()) return '';
    const url = guest.getURL();
    const record = linkedSignInFor(await deps.store.list(), url, tracker.flowSites(guest.id, url));
    if (!record) return '';
    const key = [input.sessionId, input.turnId, deps.pageId(guest), record.site].join('\0');
    if (shown.has(key)) return '';
    shown.add(key);
    if (shown.size > SHOWN_MEMORY) shown.delete(shown.values().next().value as string);
    return linkedSignInLine(record);
  }

  return { watch, navigationPost, beforeAction, replyLine };
}
