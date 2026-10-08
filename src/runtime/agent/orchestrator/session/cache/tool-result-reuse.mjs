// One freshness authority for eager admission, cross-turn references and
// serial cache hits. A readOnlyHint alone never proves a result reusable.
import { tryReadCached } from './read-cache.mjs';
import { tryScopedToolCached } from './scoped-cache.mjs';
import { _isReadTool, _isScopedCacheableTool, _stripMcpPrefix } from '../loop/tool-classify.mjs';

export function lookupToolResultReuse({ sessionId, call, cwd, touch = true }) {
  if (!sessionId) return null;
  if (_isReadTool(call.name)) {
    const entry = tryReadCached({ sessionId, args: call.arguments, cwd });
    return entry === null ? null : { kind: 'read', entry };
  }
  if (_isScopedCacheableTool(call.name)) {
    // Keep the existing dependency invalidation + bounded TTL contract;
    // this is not an instantaneous snapshot of an entire directory tree.
    const entry = tryScopedToolCached({
      sessionId,
      toolName: _stripMcpPrefix(call.name),
      args: call.arguments,
      cwd,
      touch,
    });
    return entry === null ? null : { kind: 'scoped', entry };
  }
  // In particular, remote/MCP read-only tools have no local freshness proof.
  return null;
}
