import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const PREFIX = 'cursor_native_';
const pendingCalls = new Map();
const AUTHORIZATION_MS = 10 * 60 * 1000;

export function isCursorNativeCallId(id) {
  return typeof id === 'string' && id.startsWith(PREFIX);
}

// Registered before streaming the call, including when a later frame is partial.
// Model arguments never grant this capability.
export function registerCursorNativeCall(ownerSessionId, pending, executions) {
  if (!ownerSessionId || !pending.native) return;
  if (pending.toolName !== 'read' && pending.toolName !== 'edit') return;
  if (!['readResult', 'writeResult'].includes(pending.native.resultType)) return;
  const now = Date.now();
  for (const [id, entry] of pendingCalls) {
    if (entry.expiresAt <= now) pendingCalls.delete(id);
  }
  if (pendingCalls.size >= 4096) throw new Error('Cursor native execution authorization capacity exceeded');
  pending.toolCallId = `${PREFIX}${randomUUID()}`;
  const entry = {
    ownerSessionId,
    pending,
    executions,
    expiresAt: now + AUTHORIZATION_MS,
    arguments: JSON.parse(pending.decodedArgs),
  };
  pendingCalls.set(pending.toolCallId, entry);
}

export function cursorNativeCall(ownerSessionId, id, name, args) {
  if (!isCursorNativeCallId(id)) return null;
  const entry = pendingCalls.get(id);
  if (!entry) throw new Error('Cursor native execution authorization is missing');
  if (entry.expiresAt <= Date.now()) throw new Error('Cursor native execution authorization expired');
  if (entry.ownerSessionId !== ownerSessionId) throw new Error('Cursor native execution authorization owner mismatch');
  if (entry.pending.toolName !== name) throw new Error('Cursor native execution authorization tool mismatch');
  if (!isDeepStrictEqual(entry.arguments, args))
    throw new Error('Cursor native execution authorization argument mismatch');
  return entry;
}

export function releaseCursorNativeCall(pending) {
  pendingCalls.delete(pending.toolCallId);
}
