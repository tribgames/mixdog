// Links in mails the runtime itself read for a session through Mixdog's own
// Gmail connector (connectors/gmail-app-password.mjs): the one way a link
// carrying a token (a sign-up or sign-in confirmation) becomes navigable in
// Browser Use, whose desktop host refuses every other agent URL with one
// (apps/desktop/src/main/browser/url-policy.ts). A link is recorded from the
// read_email result the runtime received (session/loop/tool-exec/dispatch.mjs),
// never from anything the model passes, and is offered only for that exact
// link, in the same session, for a short time; the desktop checks it again.
// Only a mail whose one From mailbox Gmail authenticated counts, and only the
// link targets the connector read from it (its `links`: HTML hyperlinks and
// the URIs of its text part, exactly as written).
import { getDomain } from 'tldts';

/** How long after the read a mail's link stays navigable: the lifetime the
 *  desktop gives a sign-in flow, a 2-step check included
 *  (apps/desktop/src/main/browser/linked-sign-in.ts FLOW_TTL_MS), which its
 *  url-policy.ts MAIL_LINK_WINDOW_MS takes and enforces again. */
export const MAIL_LINK_WINDOW_MS = 30 * 60_000;

/** sessionId → [{ url, from_domain, read_at }], oldest first. */
const linksBySession = new Map();

/** `domain` as a URL host spells it (IDNs in punycode), '' when it is none. */
function hostOf(domain) {
  const text = String(domain || '').toLowerCase();
  if (!/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(text)) return '';
  try {
    return new URL(`https://${text}/`).hostname;
  } catch {
    return '';
  }
}

/** The Organizational Domain (RFC 7489 §3.2: by the public suffix list; its
 *  private suffixes included, as the desktop's url-policy.ts reads it, so
 *  `a.github.io` is not `b.github.io`); '' for none. */
const siteOf = (host) => (host ? getDomain(host, { allowPrivateDomains: true }) || '' : '');

/** The From domain of read_email header `head` (connectors/gmail-app-password.mjs)
 *  when From names exactly one mailbox (with several, RFC 7489 §6.6.1 checks
 *  each author domain, and one verdict cannot vouch for the one a link names)
 *  and Gmail authenticated it: DMARC passed for that very
 *  domain, or a passing DKIM signature's d= is aligned with it in relaxed
 *  mode — the same Organizational Domain (RFC 7489 §3.1.1). '' otherwise. */
function authenticatedSender(head) {
  const from = Array.isArray(head?.fromAddresses) ? head.fromAddresses : [];
  const address = from.length === 1 ? String(from[0]?.address || '') : '';
  const host = address.includes('@') ? hostOf(address.slice(address.lastIndexOf('@') + 1)) : '';
  if (!host) return '';
  const { dmarc, dkim } = head.authentication || {};
  if (dmarc?.result === 'pass' && hostOf(dmarc.from) === host) return host;
  const site = siteOf(host);
  const signed = Array.isArray(dkim) && dkim.some((sig) => sig?.result === 'pass' && siteOf(hostOf(sig.domain)) === site);
  return site && signed ? host : '';
}

/** The normalized https URL `raw` is, or ''. */
function httpsHref(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function pruneExpired(now) {
  for (const [sessionId, links] of linksBySession) {
    const live = links.filter((link) => now - link.read_at <= MAIL_LINK_WINDOW_MS);
    if (live.length) linksBySession.set(sessionId, live);
    else linksBySession.delete(sessionId);
  }
}

/** Records the https link targets of read_email result `result` (its header
 *  line — `links` among its fields — a blank line, the body) for `sessionId`,
 *  with the authenticated sender's domain. Links leave only by the window. */
export function recordMailLinks(sessionId, result, now = Date.now()) {
  pruneExpired(now);
  const owner = String(sessionId || '');
  if (!owner || typeof result !== 'string') return;
  const split = result.indexOf('\n\n');
  if (split < 0) return;
  let head;
  try {
    head = JSON.parse(result.slice(0, split));
  } catch {
    return;
  }
  const from_domain = authenticatedSender(head);
  if (!from_domain || !Array.isArray(head.links)) return;
  const found = new Set(head.links.map((link) => (typeof link === 'string' ? httpsHref(link) : '')).filter(Boolean));
  if (!found.size) return;
  const kept = (linksBySession.get(owner) || []).filter((link) => !found.has(link.url));
  for (const url of found) kept.push({ url, from_domain, read_at: now });
  linksBySession.set(owner, kept);
}

/** `{ url, from_domain, read_at }` when `url` is exactly a link of a mail read
 *  for `sessionId` within the window, else null. */
export function mailLinkFor(sessionId, url, now = Date.now()) {
  pruneExpired(now);
  const href = httpsHref(String(url || '').trim());
  const link = href ? linksBySession.get(String(sessionId || ''))?.find((entry) => entry.url === href) : null;
  return link ? { ...link } : null;
}
