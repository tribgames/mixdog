// Skill dependencies use the existing deferred registry. Native providers keep
// definitions out of the eager prefix; selection never changes permission policy.
import { deferredCatalogUnion, selectDeferredTools, toolSearchNativePayload } from './tool-catalog.mjs';
import { preDispatchDenyForSession } from '../session/loop/pre-dispatch-deny.mjs';
import { parseMcpToolName } from '../../../shared/tool-primitives.mjs';
import { isToolBridgeEnabled } from './tool-exposure.mjs';

export function loadSkillToolDependencies(envelope, session, mode) {
  if (!envelope?.__toolEnvelope) return envelope;
  const dependencies = envelope.skillToolDependencies || [];
  const unavailable = [...(envelope.skillDependencyIssues || [])];
  if (!dependencies.length && !unavailable.length) return envelope;
  const catalog = new Map(
    [...(session?.tools || []), ...deferredCatalogUnion(session)].map((tool) => [tool.name, tool])
  );
  const names = new Set();
  for (const { type, value } of dependencies) {
    if (type === 'tool') names.add(value);
    else if (type === 'mcp') {
      const matches = [...catalog.values()]
        .filter((tool) => parseMcpToolName(tool)?.server === value)
        .map((tool) => tool.name);
      if (matches.length)
        matches.forEach((name) => {
          names.add(name);
        });
      else unavailable.push(`mcp:${value} (no available connected tools)`);
    } else unavailable.push(`${type}:${value} (unsupported dependency type)`);
  }
  const allowed = [];
  for (const name of names) {
    if (!session || !Array.isArray(session.tools) || !catalog.has(name)) {
      unavailable.push(`${name} (not available in this session)`);
      continue;
    }
    const denial = preDispatchDenyForSession(session, { name, arguments: {} });
    if (denial) unavailable.push(`${name} (${denial})`);
    else allowed.push(name);
  }
  const readonlySpec = session?.toolSpec === 'readonly' || session?.toolSpec?.includes?.('tools:readonly');
  const specMode = session?.toolSpec === 'full' || session?.toolSpec === 'mcp' ? 'full' : 'readonly';
  const selectedMode = readonlySpec ? 'readonly' : mode || session?.deferredSurfaceMode || specMode;
  const selection = allowed.length ? selectDeferredTools(session, allowed, selectedMode, { exact: true }) : null;
  const loaded = [...(selection?.added || []), ...(selection?.already || [])];
  for (const item of selection?.blocked || []) unavailable.push(`${item.name} (${item.reason})`);
  for (const name of selection?.missing || []) unavailable.push(`${name} (not available in this session)`);
  if (loaded.length) {
    session.skillLoadedTools = [...new Set([...(session.skillLoadedTools || []), ...loaded])];
  }
  const eager = new Set((session?.tools || []).map((tool) => tool.name));
  // Bridge exposure never promotes a schema: deferred dependencies stay
  // reachable through call_tool while the eager surface keeps its bytes.
  const bridged = isToolBridgeEnabled(session) ? loaded.filter((name) => !eager.has(name)) : [];
  const direct = loaded.filter((name) => !bridged.includes(name));
  const summary = [
    envelope.result,
    ...(direct.length && !isToolBridgeEnabled(session)
      ? [
          `Required tools loaded: ${direct.join(', ')}. Their full definitions are available on your next request; use them directly without load_tool.`,
        ]
      : []),
    ...(direct.length && isToolBridgeEnabled(session)
      ? [`Required tools available directly: ${direct.join(', ')}.`]
      : []),
    ...(bridged.length
      ? [
          `Required tools available through call_tool: ${bridged.join(', ')}. Read a definition with load_tool, then run it with call_tool {name, arguments}.`,
        ]
      : []),
    ...(unavailable.length
      ? [
          `Required tools unavailable: ${unavailable.join('; ')}`,
          'No tools were installed or enabled and no permissions were changed.',
        ]
      : []),
  ].join('\n');
  const native = selection?.native
    ? toolSearchNativePayload(
        [...catalog.values()],
        loaded.filter((name) => !eager.has(name)),
        session?.provider
      )
    : null;
  return {
    ...envelope,
    result: native ? JSON.stringify({ nativeToolSearch: { ...native, summary } }) : summary,
  };
}
