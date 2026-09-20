/**
 * src/tui/session/session-api.mjs - part of the public session runtime session object.
 *
 * createSessionApiA composes the surface groups under session-api/ (intake,
 * settings, controls, extensions, commands); createSessionApiB
 * (session-api-ext.mjs) adds the rest, and createSessionApi merges both.
 */
import { createSessionApiB } from './session-api-ext.mjs';
import { createSessionIntakeApi } from './session-api/intake.mjs';
import { createSessionSettingsApi } from './session-api/settings.mjs';
import { createSessionControlsApi } from './session-api/controls.mjs';
import { createSessionExtensionsApi } from './session-api/extensions.mjs';
import { createSessionCommandsApi } from './session-api/commands.mjs';

export function createSessionApi(bag) {
  const api = { ...createSessionApiA(bag), ...createSessionApiB(bag) };
  // One-shot settings/status bundle. On a daemon-backed store every getter is
  // its own serialized round-trip and the settings panel needs a dozen of them,
  // so the panel asks for this instead of fanning out. It calls the SAME
  // methods (no second source of truth) and degrades a failing getter to null.
  api.getSettingsSnapshot = async ({ heavy = true } = {}) => {
    const read = async (fn, ...args) => {
      if (typeof fn !== 'function') return null;
      try {
        return await fn.call(api, ...args);
      } catch {
        return null;
      }
    };
    const snapshot = {
      autoClear: await read(api.getAutoClear),
      compaction: await read(api.getCompactionSettings),
      recap: await read(api.getRecapSettings),
      toolModules: await read(api.getToolModuleSettings),
      channels: await read(api.getChannelSettings, { includeStatus: false }),
      systemShell: await read(api.getSystemShell),
      webSearchRoute: await read(api.getWebSearchRoute),
      outputStyle: (await read(api.getOutputStyle)) || (await read(api.listOutputStyles)),
      channelWorker: await read(api.getChannelWorkerStatus),
      profile: await read(api.getProfile),
      updateSettings: await read(api.getUpdateSettings),
    };
    if (heavy) {
      snapshot.mcp = await read(api.mcpStatus);
      snapshot.plugins = await read(api.pluginsStatus);
      snapshot.skills = await read(api.skillsStatus);
    }
    return snapshot;
  };
  return api;
}

export function createSessionApiA(bag) {
  return {
    ...createSessionIntakeApi(bag),
    ...createSessionSettingsApi(bag),
    ...createSessionControlsApi(bag),
    ...createSessionExtensionsApi(bag),
    ...createSessionCommandsApi(bag),
  };
}
