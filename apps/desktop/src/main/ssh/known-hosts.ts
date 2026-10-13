// known_hosts reading: which keys the user's files (and the system-wide one)
// hold for a server, including hashed entries, wildcard patterns and the
// @revoked / @cert-authority markers. Pure text in, entries out.
import { createHash, createHmac } from 'node:crypto';

export type KnownHostMarker = '' | 'revoked' | 'cert-authority';

export interface KnownHostEntry {
  marker: KnownHostMarker;
  /** The host field as written (patterns, or a |1|salt|hash). */
  hosts: string;
  type: string;
  key: string;
}

const KEY_BODY = /^[A-Za-z0-9+/=]+$/;

export function parseKnownHostsText(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: KnownHostMarker = '';
    if (fields[0] === '@revoked') marker = 'revoked';
    else if (fields[0] === '@cert-authority') marker = 'cert-authority';
    else if (fields[0].startsWith('@')) continue;
    if (marker) fields.shift();
    const [hosts, type, key] = fields;
    if (hosts && type && key && KEY_BODY.test(key)) entries.push({ marker, hosts, type, key });
  }
  return entries;
}

const wildcard = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i'
  );

function patternMatches(pattern: string, spec: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    try {
      return createHmac('sha1', Buffer.from(salt, 'base64')).update(spec).digest('base64') === hash;
    } catch {
      return false;
    }
  }
  return wildcard(pattern).test(spec);
}

/** Does the known_hosts host field cover `spec` (`host` or `[host]:port`)? A
 *  `!pattern` that matches excludes the whole line. */
export function hostFieldMatches(field: string, spec: string): boolean {
  let matched = false;
  for (const pattern of field.split(',')) {
    if (pattern.startsWith('!')) {
      if (patternMatches(pattern.slice(1), spec)) return false;
    } else if (patternMatches(pattern, spec)) {
      matched = true;
    }
  }
  return matched;
}

export const entriesFor = <T extends KnownHostEntry>(entries: readonly T[], spec: string): T[] =>
  entries.filter((entry) => hostFieldMatches(entry.hosts, spec));

/** `SHA256:<unpadded base64>`, the form ssh and server panels print. */
export const keyFingerprint = (key: string): string =>
  `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`;
