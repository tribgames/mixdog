import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { normalizeActivityRailPins, storedPinsState, type ActivityRailPinsState } from '../shared/activity-rail-pins';
import { normalizeDesktopFeedback } from '../shared/contract-feedback';
import { desktopSettingPath, desktopSettingsFromConfig } from '../shared/desktop-settings';
import { readHostDisplayPreferences } from '../shared/host-display-preferences';
import {
  activeOverrides,
  notificationPreferencesStateOf,
  notificationWriteMode,
  storedOverrides,
} from '../shared/notification-state';
import { announcedEvent } from '../shared/core-announcements';
import { configuredOrchestrationMode } from '../shared/orchestration-mode';
import type { ProviderModelsChange } from '../shared/provider-models';
import { requiredString } from '../shared/remote-arguments';
import { SETTINGS_CHANGED_EVENT, type SettingsChange } from '../shared/settings-changed';
import {
  requiredConversationNotificationSetting,
  requiredDesktopSettingKey,
  requiredNotificationDeviceId,
  requiredNotificationPreferencesPatch,
  requiredNotificationTarget,
} from '../shared/settings-input';
import { phoneCallError } from './remote-protocol-scm';
import type { NodeCall, PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';
import { record } from './record-utils';

type Client = ProtocolClient<SessionFold>;

/** What Node's host answered when the PC's window process did not answer its request (desktop-service.ts:279-284, the 20 s bound
 *  of every window request): the core says it at once, as `capabilityUnavailable{desktopHost}`, or by holding no window state. */
const NO_WINDOW = 'The desktop app did not answer the remote request.';

/** The held value of `(section, key)`, or undefined while the core holds none. */
const held = (client: Client, section: string, key: string | null = null): unknown =>
  client.store.section(section as never, key)?.value;

type ClientSource = Pick<PhoneProtocolHost, 'client'>;
const boundTo = (client: Client): ClientSource => ({ client: () => client });

/** A config subtree as the page reads it: the held value, or, when the core published it as a stub (over the inline limit, held as
 *  null), the value config/read answers for exactly that subtree. */
async function configTree(source: ClientSource, subtree: string): Promise<unknown> {
  const value = held(source.client(), 'config', subtree);
  if (value !== null) return value;
  return record(record(await request(source, 'config/read', { keys: [subtree] })).config)[subtree];
}

/** Node's phone read a refused call as an `Error` carrying the host's text (remote-shim-dispatch.ts:165-178). */
const refused = (text: string): Error => new Error(text);

async function updatePins(pins: unknown, host: PhoneProtocolHost): Promise<ActivityRailPinsState> {
  // settings-store.ts:274-275: the list is checked before anything is written.
  if (!normalizeActivityRailPins(pins)) throw refused('Activity rail pins must be an array of supported destinations.');
  const reply = record(
    await host.client().call('config/value/write', { path: 'desktop.activityRailPins', value: pins } as never)
  );
  const values = reply.values;
  const state = storedPinsState(Array.isArray(values) ? values[0] : undefined);
  if (!state) throw refused('The config write did not return valid activity rail pins.');
  return state;
}

/** The store's `owed`, which the library's `FoldStore` type does not name (section-store.ts `FoldStoreLike` reads it the same way):
 *  set while the sections a snapshot swapped in are still being announced. */
const announcingSnapshot = (client: Client): boolean => Boolean((client.store as { readonly owed?: unknown }).owed);

/** Tells the page each pins revision the connected client hears live; what a connection's snapshot holds is not announced. A
 *  read that a newer change superseded, or that ends after the client was dropped, is discarded. */
function followPins(host: PhoneProtocolHost, client: Client): () => void {
  let told = 0;
  let latest = 0;
  let closed = false;
  const check = (announce: boolean): void => {
    const mine = ++latest;
    void configTree(boundTo(client), 'desktop').then(
      (tree) => {
        if (closed || mine !== latest) return;
        const state = storedPinsState(record(tree).activityRailPins);
        if (!announce) told = state?.revision ?? 0;
        else if (state && state.revision !== told) {
          told = state.revision;
          host.ctx.fanOut(host.ctx.activityRailPinsListeners, state);
        }
      },
      () => undefined
    );
  };
  check(false);
  const off = client.store.subscribe((change) => {
    // A snapshot announces every section it holds: it is where the pins stand, not a change.
    if (change.type === 'appSnapshot') check(false);
    else if (
      change.type === 'section' &&
      change.section === 'config' &&
      change.key === 'desktop' &&
      !announcingSnapshot(client)
    )
      check(true);
  });
  return () => {
    closed = true;
    off();
  };
}
const isWindowGone = (error: unknown): boolean => {
  const failure = (error as { detail?: { kind?: unknown; data?: { reason?: unknown; capability?: unknown } } } | null)
    ?.detail;
  return (
    failure?.kind === 'rpc' &&
    failure.data?.reason === 'capabilityUnavailable' &&
    failure.data.capability === 'desktopHost'
  );
};

/** One core request; a failure is the error Node's relay frame carried. */
async function request(host: ClientSource, method: string, params: unknown): Promise<unknown> {
  try {
    return await (host.client().call as (m: string, p: unknown) => Promise<unknown>)(method, params);
  } catch (error) {
    throw isWindowGone(error) ? new Error(NO_WINDOW) : phoneCallError(error);
  }
}

/** The core's relay view contains only the roster inputs notification settings need, not a host provisioning descriptor. */
async function notificationRoster(host: PhoneProtocolHost) {
  const { settings, clients, pushRegistered } = record(await request(host, 'remoteAccess/state', {}));
  return { settings: { name: record(settings).name }, clients, pushRegistered };
}

/** The notification settings as Node's `notificationPreferencesState(currentDeviceId, null)` answered them: whether this PC shows
 *  notifications (Node asked its window, desktop-service.ts:866) and the stored document after every listed device's default was
 *  written, from the core (`notify/state`); the devices from `notificationRoster`. The current device is this connection's paired
 *  credential. */
async function notificationState(host: PhoneProtocolHost) {
  const remote = await notificationRoster(host);
  const state = record(await request(host, 'notify/state', {}));
  return notificationPreferencesStateOf({
    remote,
    notifications: state.notifications ?? undefined,
    currentDeviceId: host.ctx.browserId ?? '',
    pcCanNotify: state.supported === true,
    // The core uses the machine's name when none was set.
    hostName: () => '',
  });
}

/** A Node call (the router hands it the arguments as Node's relay JSON carried them), the answer `undefined` as null. */
const call =
  (run: (args: unknown[], host: PhoneProtocolHost) => unknown): NodeCall =>
  async (params, host) => {
    const value = await run(params, host);
    return value === undefined ? null : value;
  };

const calls: Record<string, NodeCall> = {
  // ── settings (settingsRemoteMethods, remote-methods.ts:1086-1107) ──
  readSettings: call(async (_args, host) =>
    desktopSettingsFromConfig({ agent: await configTree(host, 'agent'), desktop: await configTree(host, 'desktop') })
  ),
  // Node answered the desktop settings of the config its locked update saved; the core's write answers that config. Node then
  // announced `desktop` to every client whether or not anything changed (remote-methods.ts:1098): the write's `announce`.
  updateSetting: call(async ([key, enabled], host) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    const path = desktopSettingPath(requiredDesktopSettingKey(key));
    const saved = await request(host, 'config/value/write', { path, value: enabled, announce: 'desktop' });
    return desktopSettingsFromConfig(record(saved).config);
  }),
  readActivityRailPins: async (_params, host) =>
    storedPinsState(record(await configTree(host, 'desktop')).activityRailPins),
  // remote-methods.ts:915: a phone's update never initializes; only its first argument reaches the store.
  updateActivityRailPins: ([pins], host) => updatePins(pins, host),

  // ── this PC's window (hostWindowRemoteMethods, :1053-1084) ──
  readHostDisplayPreferences: call((_args, host) => {
    const entry = host.client().store.section('hostState' as never, 'displayPreferences');
    if (!entry) throw new Error(NO_WINDOW);
    return readHostDisplayPreferences(entry.value);
  }),
  getUpdaterState: call((_args, host) => {
    const entry = host.client().store.section('update' as never, null);
    if (!entry) throw new Error(NO_WINDOW);
    return entry.value;
  }),
  checkForDesktopUpdate: call((_args, host) => request(host, 'update/desktop/command', { action: 'check' })),
  showDesktopUpdate: call(([confirmed], host) =>
    request(host, 'update/desktop/command', { action: 'install', confirmed: confirmed === true })
  ),

  // ── workspace calls (:912-917) ──
  // The PC posted the feedback after the same check (feedback-client.ts `normalizeDesktopFeedback`).
  submitFeedback: call(([input], host) => {
    normalizeDesktopFeedback(input);
    return request(host, 'feedback/upload', { input });
  }),
  notifyProviderModelsChanged: call(async ([origin], host) => {
    await request(host, 'ui/providerModels/announce', { origin: requiredString(origin, 'origin', 128) });
    return null;
  }),

  // ── Settings › Notifications (notificationRemoteMethods, :1109-1131) ──
  getNotificationPreferences: call((_args, host) => notificationState(host)),
  // Node: the device must be paired, then the patch merged in one write, then the state as above (notification-center.ts:106-117).
  setNotificationPreferences: call(async ([deviceId, patch], host) => {
    const id = requiredNotificationDeviceId(deviceId);
    const value = requiredNotificationPreferencesPatch(patch);
    const mode = notificationWriteMode(id, await notificationRoster(host), await configTree(host, 'notifications'));
    await request(host, 'config/value/write', { path: `notifications.devices.${id}`, value, mode });
    return notificationState(host);
  }),
  sendTestNotification: call(([deviceId], host) =>
    request(host, 'notify/test', { target: requiredNotificationDeviceId(deviceId) })
  ),
  listConversationNotifications: call(async (_args, host) =>
    activeOverrides(storedOverrides(await configTree(host, 'notifications')), Date.now())
  ),
  // Node answered the overrides in force after the write: the stored list the write answers.
  setConversationNotification: call(async ([target, setting], host) => {
    const value = {
      target: requiredNotificationTarget(target),
      setting: requiredConversationNotificationSetting(setting),
    };
    const saved = record(
      await request(host, 'config/value/write', { path: 'notifications.overrides', value, mode: 'setConversation' })
    );
    return Array.isArray(saved.values) ? saved.values[0] : null;
  }),
};

/** Notifications and held config/state reach the page through the same listeners as Node's relay. */
function install(host: PhoneProtocolHost): (() => void) | undefined {
  const { ctx } = host;
  let unwire: (() => void) | undefined;
  let toldMode: ReturnType<typeof configuredOrchestrationMode> | undefined;
  const wire = (client: Client): void => {
    unwire?.();
    // A read of a stubbed `agent` subtree that a newer change superseded, or that ends after this wiring ended, is discarded.
    let latestMode = 0;
    let wired = true;
    const followMode = (announce: boolean): void => {
      const mine = ++latestMode;
      void configTree(boundTo(client), 'agent').then(
        (tree) => {
          if (!wired || mine !== latestMode) return;
          const mode = configuredOrchestrationMode(tree);
          const previous = toldMode;
          toldMode = mode;
          // Initialization only records the mode. A live change is published when it differs from the mode told; when none was told
          // yet because the initial read was superseded, it is compared with what the fold held at wiring (unknown for a stub).
          const changed =
            previous !== undefined
              ? mode !== previous
              : announce && (initialMode === undefined || mode !== initialMode);
          if (changed) ctx.fanOut(ctx.orchestrationModeListeners, { mode });
        },
        () => undefined
      );
    };
    // The mode the fold holds at wiring (a stub reads as unknown): the baseline a live change is compared with until a read has told one.
    const heldAgent = held(client, 'config', 'agent');
    const initialMode = heldAgent === null ? undefined : configuredOrchestrationMode(heldAgent);
    if (client.store.appFeed()) followMode(false);
    const offStore = client.store.subscribe((change) => {
      if (
        change.type === 'appSnapshot' ||
        (change.type === 'section' &&
          change.section === 'config' &&
          change.key === 'agent' &&
          !announcingSnapshot(client))
      ) {
        followMode(change.type === 'section');
      }
      if (change.type !== 'section' || change.section !== 'update') return;
      const state = client.store.section('update' as never, null)?.value as { status?: unknown } | undefined;
      if (state && typeof state === 'object' && typeof state.status === 'string')
        ctx.fanOut(ctx.updaterListeners, state as never);
    });
    const offEvents = client.on((event) => {
      if (event.type !== 'notification') return;
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      const announced = announcedEvent(method, params);
      if (!announced) return;
      if (announced.name === SETTINGS_CHANGED_EVENT)
        ctx.fanOut(ctx.settingsChangedListeners, announced.value as SettingsChange);
      else ctx.fanOut(ctx.providerModelsListeners, announced.value as ProviderModelsChange);
    });
    const offPins = followPins(host, client);
    unwire = () => {
      wired = false;
      offStore();
      offEvents();
      offPins();
    };
  };
  const off = host.onClient?.(wire);
  const offReset = host.onPairingReset?.(() => unwire?.());
  if (!off)
    void ctx.phone.start().then(
      () => wire(host.client()),
      () => undefined
    );
  return () => {
    off?.();
    offReset?.();
    unwire?.();
  };
}

export const adapter: PhoneProtocolAdapter = { group: 'settings', calls, install };
