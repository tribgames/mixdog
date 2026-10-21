// Diagnostic per-block prefix fingerprint of an Anthropic request: the tools,
// each system block (BP1/BP2/BP3/env, the routing prefix included) and the
// cache_control marker positions, as short hashes only — never any text, so
// it is safe in shipped builds. The last two requests per session are kept in
// memory so a usage-detected cache miss (session/loop/send-phase.mjs) can say
// which block or marker moved.
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

const markerTtl = (marker) => (marker?.ttl ? String(marker.ttl) : '5m');

/** `{ tools, system: [hash…], markers: ['s1:1h', 'm12:5m', …] }` of a request body. */
export function anthropicPrefixFingerprint(body) {
  const system = Array.isArray(body?.system) ? body.system : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const markers = [];
  system.forEach((block, index) => {
    if (block?.cache_control) markers.push(`s${index}:${markerTtl(block.cache_control)}`);
  });
  messages.forEach((message, index) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    const marked = content.find((block) => block?.cache_control);
    if (marked) markers.push(`m${index}:${markerTtl(marked.cache_control)}`);
  });
  return { tools: hash(body?.tools || []), system: system.map((block) => hash(withoutMarker(block))), markers };
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

/** `{ changedBlocks: 'tools,s3' | 'none', markersChanged }` between the session's
 *  last two requests, or null before it has two. */
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
  // Message markers move every turn; only the system markers are a layout change.
  const systemMarkers = (print) => print.markers.filter((marker) => marker.startsWith('s')).join(',');
  return {
    changedBlocks: changed.length ? changed.join(',') : 'none',
    markersChanged: systemMarkers(previous) !== systemMarkers(current),
  };
}
