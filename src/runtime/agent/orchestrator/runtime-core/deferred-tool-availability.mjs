const lowerName = (name) => String(name || '').toLowerCase();

/** The persisted schema allowlist (also the execution allowlist) leaves `name` out. */
export function sessionAllowlistExcludes(session, name) {
  if (!Array.isArray(session?.schemaAllowedTools)) return false;
  return !session.schemaAllowedTools.some((allowed) => lowerName(allowed) === lowerName(name));
}

/** The session's denied tools name `name`. */
export function sessionDisallows(session, name) {
  return Array.isArray(session?.disallowedTools) && session.disallowedTools.some((denied) => lowerName(denied) === lowerName(name));
}

/**
 * The session's own tool policy permits `name`: discovery (load_tool by name
 * or query) shows, selects and describes only what execution would run.
 */
export function isToolPermittedBySessionPolicy(session, name) {
  return !sessionAllowlistExcludes(session, name) && !sessionDisallows(session, name);
}

// Discovery history retains definitions; only the latest scoped MCP snapshot
// grants availability. An absent snapshot preserves pre-initialization behavior.
export function isDeferredToolAvailable(session, name) {
  return (
    !String(name || '').startsWith('mcp__') ||
    !Array.isArray(session?.deferredMcpToolNames) ||
    session.deferredMcpToolNames.includes(name)
  );
}
