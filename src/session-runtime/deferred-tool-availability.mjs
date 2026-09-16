// Discovery history retains definitions; only the latest scoped MCP snapshot
// grants availability. An absent snapshot preserves pre-initialization behavior.
export function isDeferredToolAvailable(session, name) {
  return (
    !String(name || '').startsWith('mcp__') ||
    !Array.isArray(session?.deferredMcpToolNames) ||
    session.deferredMcpToolNames.includes(name)
  );
}
