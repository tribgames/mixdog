// Diagnostic per-block prefix fingerprint of an Anthropic request: the tools,
// each system block (BP1/BP2/BP3/env, the routing prefix included), the
// thinking parameters (they key the message cache), the cache_control marker
// positions and, at each marked message, a chained hash of the messages up to
// it — as short hashes only, never any text, so it is safe in shipped builds.
// The last two requests per session are kept in memory so a usage-detected
// cache miss (session/loop/send-phase.mjs) can say which block, marker or
// message breakpoint moved. The latest one also rides on the session record
// (persistableAnthropicPrefix / seedAnthropicPrefix), so the first request
// after a restart is compared with the last one before it.
import { createHash } from 'node:crypto';

const HASH_CHARS = 12;
const MAX_SESSIONS = 256;
const bySession = new Map();

const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, HASH_CHARS);

const withoutMarker = (block) => {
  if (!block || typeof block !== 'object') return block;
  const { cache_control: _marker, ...rest } = block;
  return rest;
};

// A message as the cache reads it: markers stripped, a string content as the
// one text block a marker would turn it into.
const messageWithoutMarkers = (message) => {
  const content =
    typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : message?.content || [];
  return { ...message, content: Array.isArray(content) ? content.map(withoutMarker) : content };
};

const markerTtl = (marker) => (marker?.ttl ? String(marker.ttl) : '5m');

/** The session id a request's prefix is recorded under: the visible Mixdog
 *  session, not the account-scoped id an account roster sends under. */
export function anthropicPrefixSessionId(opts) {
  return opts?.usageSessionId || opts?.sessionId || opts?.session?.id || null;
}

/** `{ tools, system: [hash…], params, markers: ['s1:1h', 'm12:5m', …],
 *  messageMarks: [{ i, h }] }` of a request body; the full message hash chain
 *  rides along non-enumerable (memory only) for the next request's
 *  comparison. */
export function anthropicPrefixFingerprint(body) {
  const system = Array.isArray(body?.system) ? body.system : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const markers = [];
  system.forEach((block, index) => {
    if (block?.cache_control) markers.push(`s${index}:${markerTtl(block.cache_control)}`);
  });
  const params = hash({ thinking: body?.thinking ?? null, output_config: body?.output_config ?? null });
  const chain = [];
  const messageMarks = [];
  let link = params;
  messages.forEach((message, index) => {
    link = hash([link, messageWithoutMarkers(message)]);
    chain.push(link);
    const content = Array.isArray(message?.content) ? message.content : [];
    const marked = content.find((block) => block?.cache_control);
    if (marked) {
      markers.push(`m${index}:${markerTtl(marked.cache_control)}`);
      messageMarks.push({ i: index, h: link });
    }
  });
  const fingerprint = {
    tools: hash(body?.tools || []),
    system: system.map((block) => hash(withoutMarker(block))),
    params,
    markers,
    messageMarks,
  };
  Object.defineProperty(fingerprint, 'chain', { value: chain, enumerable: false });
  return fingerprint;
}

/** `fingerprint` as the session record keeps it (hashes only, no chain). */
export function persistableAnthropicPrefix(fingerprint) {
  if (!fingerprint) return null;
  const { tools, system, params, markers, messageMarks } = fingerprint;
  return { tools, system, params, markers, messageMarks };
}

/** A restarted process has no previous request for the session: take the
 *  one its record kept (persistableAnthropicPrefix) as the latest, so the
 *  next request is compared with it. A no-op once the session has one. */
export function seedAnthropicPrefix(sessionId, fingerprint) {
  if (!sessionId || !fingerprint || typeof fingerprint !== 'object') return;
  const key = String(sessionId);
  if (bySession.has(key)) return;
  bySession.set(key, { previous: null, current: persistableAnthropicPrefix(fingerprint) });
  if (bySession.size > MAX_SESSIONS) bySession.delete(bySession.keys().next().value);
}

/** Keep `fingerprint` as the session's latest request (the one before it stays as previous). */
export function recordAnthropicPrefix(sessionId, fingerprint) {
  if (!sessionId || !fingerprint) return;
  const key = String(sessionId);
  const previous = bySession.get(key)?.current || null;
  bySession.delete(key);
  bySession.set(key, { previous, current: fingerprint });
  if (bySession.size > MAX_SESSIONS) bySession.delete(bySession.keys().next().value);
}

/** The session's latest fingerprint, or null. */
export function latestAnthropicPrefix(sessionId) {
  return bySession.get(String(sessionId || ''))?.current || null;
}

/** `{ changedBlocks: 'tools,s3,params' | 'none', markersChanged,
 *  lostMessageBreakpoints? }` between the session's last two requests, or
 *  null before it has two. `lostMessageBreakpoints` ('m12,m40' | 'none')
 *  names the previous request's message breakpoints whose prefix the latest
 *  request does not repeat (absent when either side predates the chain). */
export function anthropicPrefixChanges(sessionId) {
  const entry = bySession.get(String(sessionId || ''));
  if (!entry?.previous) return null;
  const { previous, current } = entry;
  const changed = [];
  if (previous.tools !== current.tools) changed.push('tools');
  const blocks = Math.max(previous.system.length, current.system.length);
  for (let index = 0; index < blocks; index += 1) {
    if (previous.system[index] !== current.system[index]) changed.push(`s${index}`);
  }
  if (previous.params && current.params && previous.params !== current.params) changed.push('params');
  // Message markers move every turn; only the system markers are a layout change.
  const systemMarkers = (print) => print.markers.filter((marker) => marker.startsWith('s')).join(',');
  const changes = {
    changedBlocks: changed.length ? changed.join(',') : 'none',
    markersChanged: systemMarkers(previous) !== systemMarkers(current),
  };
  if (Array.isArray(previous.messageMarks) && Array.isArray(current.chain)) {
    const lost = previous.messageMarks.filter(({ i, h }) => current.chain[i] !== h).map(({ i }) => `m${i}`);
    changes.lostMessageBreakpoints = lost.length ? lost.join(',') : 'none';
  }
  return changes;
}
