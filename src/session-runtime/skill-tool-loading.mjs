// Skill-selected tools join the real request surface, not a synthetic tool-search
// result with no matching search call. Selection never changes permission policy.
import { deferredCatalogUnion, selectDeferredTools } from './tool-catalog.mjs';
import { preDispatchDenyForSession } from '../runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';

export function loadSkillToolDependencies(envelope, session, mode) {
  if (!envelope?.__toolEnvelope) return envelope;
  const dependencies = envelope.skillToolDependencies || [];
  const unavailable = [...(envelope.skillDependencyIssues || [])];
  if (!dependencies.length && !unavailable.length) return envelope;
  const catalog = new Map([
    ...(session?.tools || []), ...deferredCatalogUnion(session),
  ].map((tool) => [tool.name, tool]));
  const names = new Set();
  for (const { type, value } of dependencies) {
    if (type === 'tool') names.add(value);
    else if (type === 'mcp') {
      const matches = [...catalog.keys()].filter((name) => name.startsWith(`mcp__${value}__`));
      if (matches.length) matches.forEach((name) => names.add(name));
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
  const selectedMode = session?.toolSpec === 'readonly' || session?.toolSpec?.includes?.('tools:readonly')
    ? 'readonly' : mode || session?.deferredSurfaceMode
      || (session?.toolSpec === 'full' || session?.toolSpec === 'mcp' ? 'full' : 'readonly');
  const selection = allowed.length ? selectDeferredTools(session, allowed, selectedMode, { exact: true }) : null;
  const loaded = [...(selection?.added || []), ...(selection?.already || [])];
  for (const item of selection?.blocked || []) unavailable.push(`${item.name} (${item.reason})`);
  for (const name of selection?.missing || []) unavailable.push(`${name} (not available in this session)`);
  if (loaded.length) {
    const active = new Set(session.tools.map((tool) => tool.name));
    for (const name of loaded) {
      if (!active.has(name)) {
        const tool = { ...catalog.get(name) };
        delete tool.deferLoading;
        delete tool.defer_loading;
        session.tools.push(tool);
        active.add(name);
      }
    }
    session.skillLoadedTools = [...new Set([...(session.skillLoadedTools || []), ...loaded])];
  }
  return {
    ...envelope,
    result: [
      envelope.result,
      ...(loaded.length ? [`Required tools loaded: ${loaded.join(', ')}. Their full definitions are available on your next request; use them directly without load_tool.`] : []),
      ...(unavailable.length ? [
        `Required tools unavailable: ${unavailable.join('; ')}`,
        'No tools were installed or enabled and no permissions were changed.',
      ] : []),
    ].join('\n'),
  };
}
