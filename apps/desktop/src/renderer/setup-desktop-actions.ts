import type { DesktopApi, DesktopSettingKey, DesktopCapability, DesktopRemoteAccessInfo } from '../shared/contract';
import { NOTIFICATION_VOLUME_MAX } from '../shared/contract-settings';
import { normalizeActivityRailPins } from '../shared/activity-rail-pins';
import { DESKTOP_PET_SCALES, type DesktopPetConfig, type DesktopPetOption } from '../shared/desktop-pet';

type Values = Record<string, unknown>;
export interface SetupPreferences {
  read(): Promise<Values>;
  write(input: Values): Promise<Values>;
}
const record = (value: unknown): Values => (value && typeof value === 'object' ? (value as Values) : {});

type OptionalMethod = {
  [K in keyof DesktopApi]-?: undefined extends DesktopApi[K]
    ? NonNullable<DesktopApi[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof DesktopApi];

/** An optional Desktop API method, bound to the API; throws when this host lacks it. */
export function hostMethod<K extends OptionalMethod>(api: DesktopApi, key: K): NonNullable<DesktopApi[K]> {
  const method = api[key];
  if (typeof method !== 'function') throw new Error(`${key} is not available on this host`);
  return method.bind(api) as NonNullable<DesktopApi[K]>;
}
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

// The representative bot overlay (Settings → Bots, desktop-pet-toggle.tsx): the
// same Desktop API calls, with the Position select's mapping onto the options.
const BOT_OVERLAY_POSITIONS = ['pinned', 'pinnedHere', 'free', 'onScreen'] as const;
type BotOverlayPosition = (typeof BOT_OVERLAY_POSITIONS)[number];
const BOT_OVERLAY_BOOLEANS = ['enabled', 'keepAbove', 'collapsed', 'autoAdvance', 'autoClose'] as const;
const BOT_OVERLAY_FIELDS = [...BOT_OVERLAY_BOOLEANS, 'position', 'scale'];

const botOverlayPosition = (config: DesktopPetConfig): BotOverlayPosition =>
  config.pinned ? 'pinned' : config.pinnedHere ? 'pinnedHere' : config.onScreen ? 'onScreen' : 'free';

const botOverlayView = (config: DesktopPetConfig) => ({
  enabled: config.enabled,
  position: botOverlayPosition(config),
  keepAbove: config.keepAbove,
  collapsed: config.collapsed,
  autoAdvance: config.autoAdvance,
  autoClose: config.autoClose,
  scale: config.scale,
});

/** The overlay cannot appear without the representative bot (the Settings toggle is disabled then). */
async function representativeBotExists(api: DesktopApi): Promise<boolean> {
  const status = await api.invokeCapability({ capability: 'getLeadStatus', args: [] });
  return record(status.value).created !== false;
}

function assertBotOverlayInput(value: unknown): Values {
  const input = record(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(input).length) {
    throw new Error('botOverlay must be an object with at least one field');
  }
  for (const [key, field] of Object.entries(input)) {
    if (!BOT_OVERLAY_FIELDS.includes(key)) throw new Error(`Unsupported botOverlay field: ${key}`);
    if (key === 'position') {
      if (!BOT_OVERLAY_POSITIONS.includes(field as BotOverlayPosition)) {
        throw new Error(`botOverlay.position must be ${BOT_OVERLAY_POSITIONS.join(', ')}`);
      }
    } else if (key === 'scale') {
      if (!DESKTOP_PET_SCALES.includes(field as number)) {
        throw new Error(`botOverlay.scale must be one of ${DESKTOP_PET_SCALES.join(', ')}`);
      }
    } else if (typeof field !== 'boolean') {
      throw new Error(`botOverlay.${key} must be true or false`);
    }
  }
  return input;
}

async function applyBotOverlay(api: DesktopApi, input: Values, mutate: SetupActionContext['mutate']): Promise<Values> {
  const read = hostMethod(api, 'getDesktopPetConfig');
  const saved: string[] = [];
  try {
    if (input.enabled !== undefined) {
      await mutate(() => hostMethod(api, 'setDesktopPetEnabled')(input.enabled as boolean));
      saved.push('enabled');
    }
    if (input.position !== undefined) {
      const position = botOverlayPosition(await read());
      if (input.position !== position) {
        // Exactly the Position select: "free" turns the current placement off, any other turns itself on.
        const free = input.position === 'free';
        const name = (free ? position : input.position) as DesktopPetOption;
        await mutate(() => hostMethod(api, 'setDesktopPetOption')(name, !free));
      }
      saved.push('position');
    }
    for (const name of ['keepAbove', 'collapsed', 'autoAdvance', 'autoClose'] as const) {
      if (input[name] === undefined) continue;
      await mutate(() => hostMethod(api, 'setDesktopPetOption')(name, input[name] as boolean));
      saved.push(name);
    }
    if (input.scale !== undefined) {
      await mutate(() => hostMethod(api, 'setDesktopPetScale')(input.scale as number));
      saved.push('scale');
    }
    const view: Values = botOverlayView(await read());
    for (const [key, value] of Object.entries(input)) {
      if (view[key] !== value) throw new Error(`${key} was not persisted`);
    }
    return view;
  } catch (error) {
    // Earlier subfields stay applied: report them and the state actually in effect.
    const state = await read().then(botOverlayView, () => null);
    throw Object.assign(new Error(`${String(error)} Current botOverlay: ${JSON.stringify(state)}`), {
      saved: saved.map((field) => `botOverlay.${field}`),
    });
  }
}

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
  requireProject: (path: string | null) => Promise<string>;
  saved: (value: Values, appliesTo?: string) => Values;
};

async function statusAction({ args, api, preferences, invoke, projects }: SetupActionContext): Promise<Values> {
  switch (args.domain) {
    case 'desktop': {
      const settings = await api.readSettings();
      return {
        settings,
        notificationVolume: settings.notificationVolume,
        voice: await invoke('getVoiceStatus'),
        activityRailPins: (await api.readActivityRailPins())?.pins ?? null,
        botOverlay: api.getDesktopPetConfig
          ? {
              ...botOverlayView(await api.getDesktopPetConfig()),
              scales: DESKTOP_PET_SCALES,
              representativeBot: await representativeBotExists(api),
            }
          : null,
        scope: 'desktop-host',
      };
    }
    case 'appearance':
      return {
        ...(await preferences.read()),
        scope: 'desktop-host',
        notifications: 'Permission and subscription require a user gesture on the receiving device.',
      };
    case 'projects':
      return { projects: await projects(), scope: 'installation' };
    case 'connection':
      return {
        ...clientsOnly(await hostMethod(api, 'getRemoteAccessInfo')({ activate: false })),
        scope: 'desktop-host',
      };
    default:
      throw new Error('Unsupported Desktop status domain');
  }
}

async function setDesktopSettingsAction({ args, api, mutate, saved }: SetupActionContext): Promise<Values> {
  const input = record(args.desktop);
  const applied: string[] = [];
  let botOverlay: Values | undefined;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'botOverlay') {
      const overlay = assertBotOverlayInput(value);
      hostMethod(api, 'getDesktopPetConfig');
      if (overlay.enabled === true && !(await representativeBotExists(api))) {
        throw new Error('Create the representative bot before enabling the overlay');
      }
      continue;
    }
    if (key === 'notificationVolume') {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > NOTIFICATION_VOLUME_MAX) {
        throw new Error(`notificationVolume must be an integer from 0 to ${NOTIFICATION_VOLUME_MAX}`);
      }
      if (!api.setNotificationVolume || !globalThis.navigator?.userAgent?.includes('Windows')) {
        throw new Error('notificationVolume is only available on Windows Desktop');
      }
      continue;
    }
    if (
      ![
        'keepAwake',
        'runInBackground',
        'turnNotifications',
        'usagePinned',
        'usageRailShortLong',
        'usageAccountsExpanded',
        'usageRailSlotsThree',
        'usageRailSlotsAll',
        'computerObserveOnly',
        'browserAutoSignIn',
      ].includes(key) ||
      typeof value !== 'boolean'
    ) {
      throw new Error(`Unsupported Desktop setting: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    try {
      if (key === 'botOverlay') {
        botOverlay = await applyBotOverlay(api, value as Values, mutate);
        applied.push(key);
        continue;
      }
      const result =
        key === 'notificationVolume'
          ? await mutate(() => hostMethod(api, 'setNotificationVolume')(value as number))
          : await mutate(() => api.updateSetting(key as DesktopSettingKey, value as boolean));
      if ((result as unknown as Values)[key] !== value) throw new Error('Persisted value differs');
      applied.push(key);
    } catch (error) {
      const partial = (error as { saved?: string[] }).saved ?? [];
      throw new Error(
        `Could not save ${key}. Already saved: ${[...applied, ...partial].join(', ') || 'none'}. ${String(error)}`
      );
    }
  }
  return saved({ settings: await api.readSettings(), ...(botOverlay ? { botOverlay } : {}) });
}

async function builtinAction(
  action: string,
  { args, api, mutate, invoke, saved }: SetupActionContext
): Promise<Values> {
  const name = String(args.name);
  const enabled = action === 'install_builtin' || args.enabled === true;
  // Git and Office install like their Built-in card: the system dependency
  // first (a present one answers at once), then the runtime activation.
  if (action === 'install_builtin' && (name === 'git' || name === 'office')) {
    const dependency = await mutate(() => hostMethod(api, name === 'git' ? 'installGitCli' : 'installLibreOffice')());
    if (!dependency?.installed) {
      throw new Error(`${name === 'git' ? 'Git' : 'LibreOffice'} installation did not complete`);
    }
    const result = await mutate(() =>
      name === 'git' ? invoke('setBuiltinToolEnabled', ['git', true]) : invoke('installBuiltinFeature', ['office'])
    );
    const feature = record(result[name]);
    if (feature.installed !== true || feature.enabled !== true) {
      throw new Error(`${name} did not reach the installed and enabled state`);
    }
    return saved({ [name]: feature, dependency }, 'new sessions');
  }
  if (name !== 'browser' && name !== 'computer') {
    throw new Error('Unsupported Desktop built-in');
  }
  const installedKey = ({ browser: 'browserInstalled', computer: 'computerInstalled' } as const)[name];
  const enabledKey = ({ browser: 'browserControl', computer: 'computerControl' } as const)[name];
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

async function setActivityRailPinsAction({ args, api, mutate, saved }: SetupActionContext): Promise<Values> {
  const pins = normalizeActivityRailPins(args.activityRailPins);
  if (!pins) throw new Error('activityRailPins must list known activity rail items');
  const state = await mutate(() => api.updateActivityRailPins(pins));
  if (state.pins.join('\n') !== pins.join('\n')) throw new Error('Activity rail pins were not saved');
  return saved({ activityRailPins: state.pins });
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
  const path = await requireProject(projectPath);
  await mutate(() => api.removeProject(path));
  return {
    ...saved({
      projects: await projects(),
      recovery: 'Only registration was removed. Project files remain; re-register the same path to restore it.',
    }),
    scope: 'installation',
  };
}

async function revokeLinkedDeviceAction({ args, api, mutate, saved }: SetupActionContext): Promise<Values> {
  const id = String(args.name || '');
  const before = await hostMethod(api, 'getRemoteAccessInfo')({ activate: false });
  if (!before?.clients.some((client) => client.id === id)) throw new Error('Linked device not found');
  const after = await mutate(() => hostMethod(api, 'revokeRemoteAccessClient')(id));
  if (after?.clients.some((client) => client.id === id)) throw new Error('Device revocation was not confirmed');
  return saved({ ...clientsOnly(after), recovery: 'The device must pair again to regain access.' });
}

/** Uses the same Desktop API as the settings panels. Only the local Desktop
 * claimant runs it; the web shim must never apply host appearance to a phone. */
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
    requireProject: async (path) => {
      if (!path || !(await projects()).some((project) => project.path === path)) {
        throw new Error('Use an exact registered Project path from status projects.');
      }
      return path;
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
    case 'revoke_linked_device':
      return revokeLinkedDeviceAction(context);
    case 'set_activity_rail_pins':
      return setActivityRailPinsAction(context);
    default:
      throw new Error(`Unsupported Desktop setup action: ${action}`);
  }
}
