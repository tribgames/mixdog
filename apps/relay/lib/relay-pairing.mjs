// Browser client registration and the approval handoff (`POST /claim`,
// `GET /claim/<claimId>`). The relay routes and stores; it never authorizes:
// the desktop decides, and the pairing material it returns is sealed to the
// browser's throwaway public key, so this hop forwards a box it cannot open.
import { randomUUID } from 'node:crypto';

import { clientProfile } from './device-store.mjs';
import { isRoutingId } from './ids.mjs';
import { browserSocketOriginAllowed, clientIp, decodedRequestPath, desktopLegOpen, requestUrl } from './relay-http.mjs';
import { pairingCookieHeaders, requestCookieToken } from './static-http.mjs';

export const MAX_PENDING_CLAIMS = 64;
// The global pool is shared by every desktop on the box, so it also needs a
// per-target and per-source share: otherwise one caller (or one named device)
// fills all 64 slots and every other install gets `busy` until they expire.
export const MAX_PENDING_CLAIMS_PER_DEVICE = 8;
export const MAX_PENDING_CLAIMS_PER_SOURCE = 8;
// Long enough to walk to the desktop and answer the prompt there.
export const CLAIM_TTL_MS = 300_000;
// An approved claim stays readable this long (or until its client registers),
// so a poll answer lost on the wire can be asked for again.
export const APPROVED_CLAIM_RETAIN_MS = 60_000;
// An expired claim keeps answering `expired` this long; after that, like a
// claim this relay never held, it is `unknown`.
export const EXPIRED_CLAIM_RETAIN_MS = 60_000;

function requestToken(request, url) {
  const authorization = String(request.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+([0-9a-f]{32,128})$/i)?.[1] || '';
  return bearer || url.searchParams.get('token') || requestCookieToken(request);
}

function readBoundedJson(request, maxBytes = 8 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        rejectBody(new Error('invalid json'));
      }
    });
    request.on('error', rejectBody);
  });
}

/** The registration's request URL and JSON body, or null when either is
 *  malformed or oversized. */
async function registrationInput(request) {
  const url = requestUrl(request);
  if (!url) return null;
  try {
    return { url, body: await readBoundedJson(request) };
  } catch {
    return null;
  }
}

/** 429 while the caller is throttled, else the given rejection status. */
function rejectUnauthorized(unauthorizedLimiter, request, response, status) {
  if (!unauthorizedLimiter.allow(clientIp(request))) {
    response.writeHead(429, { 'Retry-After': '60' }).end();
    return;
  }
  response.writeHead(status).end();
}

export async function handleClientRegistration(store, unauthorizedLimiter, request, response, claims = null) {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  const input = await registrationInput(request);
  if (!input) {
    response.writeHead(400).end();
    return;
  }
  const access = store.clientAccessForToken(requestToken(request, input.url));
  const clientId = String(input.body?.clientId || '');
  if (!access || !isRoutingId(clientId)) {
    rejectUnauthorized(unauthorizedLimiter, request, response, 401);
    return;
  }
  answerRegistration(store, access, clientId, input.body, request, response);
  // The client has used its credential: it holds the answer, so the re-read
  // window of the claim that minted it closes.
  if (access.clientId === clientId) releaseApprovedClaim(claims, requestToken(request, input.url));
}

function releaseApprovedClaim(claims, token) {
  for (const [id, claim] of claims ?? []) {
    if (claim.status === 'approved' && claim.token === token) claims.delete(id);
  }
}

// A browser already bound to this token refreshes its record; a fresh one is
// minted its per-browser credential.
function answerRegistration(store, access, clientId, body, request, response) {
  const json = jsonResponder(response);
  const profile = {
    name: body?.name,
    platform: body?.platform,
    browser: body?.browser,
  };
  if (access.clientId) {
    if (access.clientId !== clientId) {
      response.writeHead(401).end();
      return;
    }
    store.touchClient(access.deviceId, clientId, profile);
    json(200, { clientId });
    return;
  }
  const registered = store.registerClient(access.deviceId, clientId, profile);
  if (!registered) {
    response.writeHead(409).end();
    return;
  }
  json(200, { clientId, token: registered.token }, pairingCookieHeaders(registered.token, request));
}

function jsonResponder(response) {
  return (status, body, headers = {}) => {
    response
      .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
      .end(JSON.stringify(body));
  };
}

// GET /claim/<id>: the container polls until the desktop answers. The claim id
// (an unguessable UUID only the original claimant was given) is the poll's
// secret; an approved claim answers with the credential to anyone who presents
// it until APPROVED_CLAIM_RETAIN_MS passes or the client registers. An id this
// relay does not hold (a restart, or retention over) is `unknown`, which the
// client answers by claiming again; `expired` is a claim that really lapsed.
function answerClaimPoll(claims, claimId, json) {
  const claim = claims.get(claimId);
  if (!claim) {
    json(200, { status: 'unknown' });
    return;
  }
  if (claim.status !== 'approved') {
    json(200, { status: claim.status });
    return;
  }
  json(200, {
    status: 'approved',
    clientId: claim.clientId,
    token: claim.token,
    sealed: claim.sealed,
  });
}

// Idempotent: a phone that reloads mid-approval (a backgrounded web app is
// discarded freely) resumes the request the user is already looking at
// instead of raising a second prompt on the desktop. A different key is a
// different container and does get its own request.
function pendingClaimId(claims, deviceId, clientId, publicKey) {
  for (const [id, pending] of claims) {
    if (
      pending.status === 'pending' &&
      pending.deviceId === deviceId &&
      pending.clientId === clientId &&
      pending.publicKey === publicKey
    ) {
      return id;
    }
  }
  return null;
}

function claimQuotaExceeded(claims, deviceId, source) {
  let deviceClaims = 0;
  let sourceClaims = 0;
  for (const pending of claims.values()) {
    if (pending.deviceId === deviceId) deviceClaims += 1;
    if (pending.source === source) sourceClaims += 1;
  }
  return (
    claims.size >= MAX_PENDING_CLAIMS ||
    deviceClaims >= MAX_PENDING_CLAIMS_PER_DEVICE ||
    sourceClaims >= MAX_PENDING_CLAIMS_PER_SOURCE
  );
}

// Records the pending claim and asks the desktop for approval.
function openClaim({ claims, entry, json }, { deviceId, clientId, publicKey, profile, source, method }) {
  const id = randomUUID();
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  claims.set(id, {
    id,
    deviceId,
    clientId,
    publicKey,
    profile,
    source,
    method,
    status: 'pending',
    token: '',
    sealed: null,
    expiresAt,
  });
  try {
    entry.socket.send(
      JSON.stringify({
        type: 'client-claim',
        claimId: id,
        clientId,
        publicKey,
        expiresAt,
        // How this container found the desktop: 'code' only when the relay
        // itself redeemed a 6-digit code for it. The client cannot claim it.
        method,
        ...profile,
      })
    );
  } catch {
    claims.delete(id);
    json(503, { status: 'offline' });
    return;
  }
  json(202, { claimId: id });
}

function sweepExpiredClaims(claims) {
  const now = Date.now();
  for (const [id, claim] of claims) {
    if (claim.expiresAt > now) continue;
    // An approved claim's retention is over, and an expired one has been told
    // so long enough: both are forgotten. Anything else lapses to `expired`.
    if (claim.status === 'approved' || claim.status === 'expired') {
      claims.delete(id);
    } else {
      claim.status = 'expired';
      claim.expiresAt = now + EXPIRED_CLAIM_RETAIN_MS;
    }
  }
}

/** The claim's routing fields, or null when any of them is malformed. */
function claimFields(body) {
  const deviceId = String(body?.deviceId || '');
  const clientId = String(body?.clientId || '');
  const publicKey = String(body?.publicKey || '');
  if (!isRoutingId(deviceId) || !isRoutingId(clientId) || !/^[A-Za-z0-9_-]{86,88}$/.test(publicKey)) {
    return null;
  }
  return { deviceId, clientId, publicKey };
}

export async function handleClaimRequest(context, request, response) {
  const { store, liveDesktops, claims, unauthorizedLimiter, pairCodes } = context;
  const json = jsonResponder(response);
  const parsed = decodedRequestPath(request);
  if (!parsed) {
    response.writeHead(400).end();
    return;
  }
  const { pathname } = parsed;
  sweepExpiredClaims(claims);
  if (request.method === 'GET' && pathname.startsWith('/claim/')) {
    answerClaimPoll(claims, pathname.slice('/claim/'.length), json);
    return;
  }
  if (request.method !== 'POST' || pathname !== '/claim') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = await readBoundedJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const fields = claimFields(body);
  if (!fields || !store.isKnown(fields.deviceId)) {
    rejectUnauthorized(unauthorizedLimiter, request, response, 404);
    return;
  }
  startClaim(
    { liveDesktops, claims, json, pairCodes },
    { ...fields, ticket: body?.ticket, retry: body?.retry === true },
    clientProfile(body, 'Web app'),
    clientIp(request)
  );
}

// Desktop online, no duplicate request, quota available: record the claim
// and ask the desktop for approval.
function startClaim(
  { liveDesktops, claims, json, pairCodes },
  { deviceId, clientId, publicKey, ticket, retry },
  profile,
  source
) {
  const entry = liveDesktops.get(deviceId);
  if (!desktopLegOpen(entry)) {
    json(503, { status: 'offline' });
    return;
  }
  const existing = pendingClaimId(claims, deviceId, clientId, publicKey);
  if (existing) {
    json(202, { claimId: existing });
    return;
  }
  if (claimQuotaExceeded(claims, deviceId, source)) {
    json(503, { status: 'busy' });
    return;
  }
  // A request with no ticket is never labelled a code; a client retrying a
  // code-started pairing says so, and the dialog calls it a retry.
  let method = 'qr';
  if (pairCodes?.takeTicket(ticket, deviceId)) method = 'code';
  else if (retry) method = 'retry';
  openClaim({ claims, entry, json }, { deviceId, clientId, publicKey, profile, source, method });
}
