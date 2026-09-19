import type { DesktopApi, DesktopSettingKey, DesktopCapability, DesktopRemoteAccessInfo } from '../shared/contract';

type Values = Record<string, unknown>;
export interface SetupPreferences {
  read(): Promise<Values>;
  write(input: Values): Promise<Values>;
}
const record = (value: unknown): Values => (value && typeof value === 'object' ? (value as Values) : {});
const clientsOnly = (info: DesktopRemoteAccessInfo | null) => ({
  available: info !== null,
  clients: (info?.clients || []).map(({ id, name, platform, browser, createdAt, lastSeenAt, online }) => ({
    id,
    name,
    platform,
    browser,
    createdAt,
    lastSeenAt,
    online,
  })),
  pairing: 'Pairing URLs and credentials remain in Settings → Connection.',
});

/** Uses the same Desktop API as the settings panels. Only the local Desktop
 * claimant runs it; the web shim must never apply host appearance to a phone. */
// What every action handler works with: the request, the Desktop API and the
// helpers that gate mutations behind the claimant check.
type SetupActionContext = {
  args: Values;
  api: DesktopApi;
  preferences: SetupPreferences;
  projectPath: string | null;
  mutate: <T>(operation: () => Promise<T>) => Promise<T>;
  invoke: (capability: DesktopCapability, values?: unknown[]) => Promise<Values>;
  projects: () => ReturnType<DesktopApi['listProjects']>;
  requireProject: (path: string | null, common?: boolean) => Promise<void>;
  saved: (value: Values, appliesTo?: string) => Values;
};

async function statusAction({ args, api, preferences, invoke, projects }: SetupActionContext): Promise<Values> {
  switch (args.domain) {
    case 'desktop':
      return { settings: await api.readSettings(), voice: await invoke('getVoiceStatus'), scope: 'desktop-host' };
    case 'appearance':
      return {
        ...(await preferences.read()),
        scope: 'desktop-host',
        notifications: 'Permission and subscription require a user gesture on the receiving device.',
      };
    case 'projects':
      return { projects: await projects(), scope: 'installation' };
    case 'connection':
      return { ...clientsOnly(await api.getRemoteAccessInfo!()), scope: 'desktop-host' };
    default:
      throw new Error('Unsupported Desktop status domain');
  }
}

async function setDesktopSettingsAction({ args, api, mutate, saved }: SetupActionContext): Promise<Values> {
  const input = record(args.desktop);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!['keepAwake', 'usagePinned', 'computerObserveOnly'].includes(key) || typeof value !== 'boolean') {
      throw new Error(`Unsupported Desktop setting: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    try {
      const result = await mutate(() => api.updateSetting(key as DesktopSettingKey, value as boolean));
      if (result[key as DesktopSettingKey] !== value) throw new Error('Persisted value differs');
      applied.push(key);
    } catch (error) {
      throw new Error(`Could not save ${key}. Already saved: ${applied.join(', ') || 'none'}. ${String(error)}`);
    }
  }
  return saved({ settings: await api.readSettings() });
}

async function builtinAction(action: string, { args, api, mutate, invoke, saved }: SetupActionContext): Promise<Values> {
  const name = String(args.name);
  const enabled = action === 'install_builtin' || args.enabled === true;
  if (name === 'voice') {
    const result = await mutate(() => invoke('toggleVoice', [enabled]));
    if (result.enabled !== enabled || (enabled && result.installed !== true)) {
      throw new Error('Voice did not reach the requested installed/enabled state');
    }
    return saved({ voice: result });
  }
  if (name !== 'browser' && name !== 'computer') throw new Error('Unsupported Desktop built-in');
  const installedKey = name === 'browser' ? 'browserInstalled' : 'computerInstalled';
  const enabledKey = name === 'browser' ? 'browserControl' : 'computerControl';
  if (action === 'install_builtin') {
    const result = await mutate(() => api.updateSetting(installedKey, true));
    if (!result[installedKey]) throw new Error(`${name} installation marker was not saved`);
  } else if (enabled && !(await api.readSettings())[installedKey]) {
    throw new Error(`Install ${name} before enabling it`);
  }
  const result = await mutate(() => api.updateSetting(enabledKey, enabled));
  if (result[enabledKey] !== enabled) throw new Error(`${name} enabled state was not saved`);
  return saved({ settings: result }, 'Desktop settings now; tool availability follows the session feature policy');
}

async function saveProjectAction({ args, api, mutate, projects, saved }: SetupActionContext): Promise<Values> {
  const input = record(args.project);
  const path = String(input.path || '');
  if (!path.trim()) throw new Error('project.path is required');
  if (!(await projects()).some((project) => project.path === path)) await mutate(() => api.addProject(path));
  if (Object.hasOwn(input, 'alias')) await mutate(() => api.renameProject(path, String(input.alias)));
  return { ...saved({ projects: await projects() }), scope: 'installation' };
}

async function removeProjectAction(context: SetupActionContext): Promise<Values> {
  const { api, mutate, projects, projectPath, requireProject, saved } = context;
  await requireProject(projectPath);
  await mutate(() => api.removeProject(projectPath!));
  return {
    ...saved({
      projects: await projects(),
      recovery: 'Only registration was removed. Project files remain; re-register the same path to restore it.',
    }),
    scope: 'installation',
  };
}

async function instructionsAction(action: string, context: SetupActionContext): Promise<Values> {
  const { args, api, mutate, projectPath, requireProject, saved } = context;
  await requireProject(projectPath, true);
  const scope = projectPath === null ? 'common' : 'project';
  if (action === 'get_instructions') {
    return { projectPath, content: await api.readInstructions!(projectPath), scope };
  }
  const receipt = await mutate(() =>
    api.writeInstructions!(projectPath, String(args.content), String(args.expectedContent))
  );
  const content = await api.readInstructions!(projectPath);
  if (content !== args.content) throw new Error('Instructions changed again after saving; read them before retrying');
  return { ...saved({ projectPath, content, ...record(receipt) }, 'new sessions'), scope };
}

async function revokeLinkedDeviceAction({ args, api, mutate, saved }: SetupActionContext): Promise<Values> {
  const id = String(args.name || '');
  const before = await api.getRemoteAccessInfo!();
  if (!before?.clients.some((client) => client.id === id)) throw new Error('Linked device not found');
  const after = await mutate(() => api.revokeRemoteAccessClient!(id));
  if (after?.clients.some((client) => client.id === id)) throw new Error('Device revocation was not confirmed');
  return saved({ ...clientsOnly(after), recovery: 'The device must pair again to regain access.' });
}

export async function executeSetupDesktopAction(
  args: Values,
  api: DesktopApi,
  preferences: SetupPreferences,
  sessionId: string,
  assertActive: () => Promise<void> = async () => {}
): Promise<Values> {
  const projects = () => api.listProjects();
  const context: SetupActionContext = {
    args,
    api,
    preferences,
    projectPath: args.projectPath === null ? null : String(args.projectPath || ''),
    mutate: async (operation) => {
      await assertActive();
      return operation();
    },
    invoke: async (capability, values = []) => {
      const receipt = await api.invokeCapability({ capability, args: values, sessionId });
      return record(receipt.value);
    },
    projects,
    requireProject: async (path, common = false) => {
      if (common && path === null) return;
      if (!path || !(await projects()).some((project) => project.path === path)) {
        throw new Error('Use an exact registered Project path from status projects.');
      }
    },
    saved: (value, appliesTo = 'the Desktop host, immediately') => ({
      ...value,
      saved: true,
      scope: 'desktop-host',
      appliesTo,
    }),
  };
  const action = String(args.action || '');
  switch (action) {
    case 'status':
      return statusAction(context);
    case 'set_desktop_settings':
      return setDesktopSettingsAction(context);
    case 'set_appearance':
      return { ...(await context.mutate(() => preferences.write(record(args.appearance)))), scope: 'desktop-host' };
    case 'install_builtin':
    case 'set_builtin_enabled':
      return builtinAction(action, context);
    case 'save_project':
      return saveProjectAction(context);
    case 'remove_project':
      return removeProjectAction(context);
    case 'get_instructions':
    case 'set_instructions':
      return instructionsAction(action, context);
    case 'revoke_linked_device':
      return revokeLinkedDeviceAction(context);
    default:
      throw new Error(`Unsupported Desktop setup action: ${action}`);
  }
}
