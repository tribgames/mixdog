// Versioned tool exposure. deferredProviderMode classifies the provider
// (native tool search or not); toolExposureMode records how the session's
// tools reach the model. Non-native providers use the fixed bridge: a small
// eager core plus the shared load_tool and call_tool, with every other tool
// only in the session's scoped catalog. Native sessions carry no field.
import { deferredProviderMode } from './tool-catalog-schema.mjs';
import { TOOL_SEARCH_TOOL } from './tool-defs.mjs';

export const TOOL_EXPOSURE_BRIDGE = 'bridge-v1';
export const TOOL_EXPOSURE_NATIVE = 'native';
export const TOOL_SURFACE_MIGRATION_INTENT = 'tool_surface_bridge_migration';

const BRIDGE_PROVIDER_MODES = new Set(['canonical', 'manifest']);
// call_tool, and the retired search_tools an older bridge surface carried.
const BRIDGE_ONLY_TOOL_NAMES = new Set(['search_tools', 'call_tool']);
// load_tool definitions earlier bridge surfaces carried: the describe-only
// bridge loader, and the shared loader with query/cursor inputs.
const LEGACY_BRIDGE_LOAD_TOOL_DESCRIPTIONS = new Set([
  'Describe tools by exact name: description, input schema and annotations, or the part one JSON Pointer selects. Large definitions arrive in chunks; pass nextCursor back for the rest. Describing never enables a tool.',
  'Load full schemas for missing deferred tool names/aliases; batch needed names in one call. Or find tools by keyword with query. Pass nextCursor back for the next page.',
]);
const SHARED_LOAD_TOOL_SCHEMA = JSON.stringify(TOOL_SEARCH_TOOL.inputSchema);

/** `route`: the session's pinned wire route (session.wireRoute), when one exists. */
export function toolExposureModeForProvider(provider, route = null) {
  return BRIDGE_PROVIDER_MODES.has(deferredProviderMode(provider, route)) ? TOOL_EXPOSURE_BRIDGE : TOOL_EXPOSURE_NATIVE;
}

export function isToolBridgeEnabled(session) {
  return session?.toolExposureMode === TOOL_EXPOSURE_BRIDGE;
}

/**
 * The exposure a session's persisted surface was built with, or null before
 * it has one. Surfaces persisted before exposure versions: native providers
 * were already native; fixed-surface providers carried the whole catalog.
 */
export function sessionToolExposure(session) {
  if (session?.toolExposureMode) return session.toolExposureMode;
  if (!session?.deferredProviderMode) return null;
  return session.deferredProviderMode === 'native' ? TOOL_EXPOSURE_NATIVE : 'legacy-fixed';
}

/**
 * True when an existing surface was built for another exposure than
 * `provider` needs, or is a bridge surface an earlier bridge revision built
 * (bridgeSurfaceOutdated).
 */
export function toolExposureMigrationNeeded(session, provider = session?.provider) {
  const current = sessionToolExposure(session);
  if (current === null) return false;
  const target = toolExposureModeForProvider(provider, session?.wireRoute);
  return current !== target || (target === TOOL_EXPOSURE_BRIDGE && bridgeSurfaceOutdated(session));
}

/**
 * A bridge session an earlier bridge revision built: its fixed prompt holds
 * other bridge guidance than the current one (the guidance-only block, or
 * guidance naming search_tools or query), or its eager surface still carries
 * search_tools or a load_tool other than the shared one.
 */
export function bridgeSurfaceOutdated(session) {
  if (!isToolBridgeEnabled(session)) return false;
  const tools = Array.isArray(session.tools) ? session.tools : [];
  const staleTool = tools.some(
    (tool) =>
      tool?.name === 'search_tools' ||
      (tool?.name === TOOL_SEARCH_TOOL.name &&
        (tool.description !== TOOL_SEARCH_TOOL.description ||
          JSON.stringify(tool.inputSchema) !== SHARED_LOAD_TOOL_SCHEMA))
  );
  if (staleTool) return true;
  return (Array.isArray(session.messages) ? session.messages : []).some(
    (message) =>
      message?.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes('<tool-bridge>') &&
      !message.content.includes(TOOL_BRIDGE_GUIDANCE)
  );
}

/** A bridge-only definition (never part of the scoped catalog). */
export function isBridgeToolDefinition(tool) {
  const name = String(tool?.name || '');
  if (BRIDGE_ONLY_TOOL_NAMES.has(name)) return true;
  return name === TOOL_SEARCH_TOOL.name && LEGACY_BRIDGE_LOAD_TOOL_DESCRIPTIONS.has(tool?.description);
}

// Static and byte-stable; it follows the deferred roster (the same
// <available-deferred-tools> block native sessions get), never replaces it.
// A prompt holding any other bridge guidance is migrated once.
export const TOOL_BRIDGE_GUIDANCE = [
  '<tool-bridge>',
  'Deferred tools (listed above, or announced later as added) are not defined here: run one with call_tool {name, arguments}, and use load_tool first to see its parameters (a keyword instead of a name searches the deferred tools). Call directly defined tools directly.',
  '</tool-bridge>',
].join('\n');
