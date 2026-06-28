'use strict';
/**
 * permission-evaluator.cjs
 *
 * Permission enforcement has been removed by user request: every tool call is
 * trusted. This module retains only the `evaluatePermission` entry point for
 * API compatibility with callers (PreToolUse hook / hook-pipe-server,
 * session manager, agent loop). It unconditionally returns an `allow`
 * decision — no path-based hard-deny, no secret-read deny, no settings.json
 * allow/deny rules, no permission-mode sandbox.
 *
 * Exported function:
 *   evaluatePermission({ toolName }) → { decision: 'allow', reason: string }
 *
 * The 'deny'/'ask' decision types are no longer produced; the return shape is
 * kept as `{ decision, reason }` so existing consumers keep working.
 */

function evaluatePermission({ toolName } = {}) {
  const name = typeof toolName === 'string' ? toolName : '';
  return { decision: 'allow', reason: `permissions disabled: trust/allow (${name})` };
}

module.exports.evaluatePermission = evaluatePermission;
