import { projectSessionMessagesForIngest } from '../../runtime/memory/lib/session-ingest.mjs';

// Read-only memory RPCs may be blanket-retried on a reset/refused connection;
// writes may not (the daemon might have applied them before dying).
export function isMemoryReadOnlyToolCall(name, args = {}) {
  const tool = String(name || '').trim();
  if (tool === 'recall' || tool === 'search_memories') return true;
  if (tool !== 'memory') return false;
  const action = String(args?.action || '').trim();
  if (action === 'status') return true;
  if (!action || action === 'core') {
    const op = String(args?.op || '').trim();
    return op === 'list' || op === 'candidates';
  }
  return false;
}

// ingest_session carries full session messages; project them to the ingest
// shape before they cross the wire so the daemon never sees tool payloads.
export function prepareMemoryToolArgumentsForWire(name, args = {}) {
  if (
    String(name || '').trim() !== 'memory' ||
    String(args?.action || '').trim() !== 'ingest_session' ||
    !Array.isArray(args?.messages)
  ) {
    return args;
  }
  return {
    ...args,
    messages: projectSessionMessagesForIngest(args.messages),
  };
}
