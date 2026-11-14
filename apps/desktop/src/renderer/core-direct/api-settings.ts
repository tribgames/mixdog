// The settings group of DesktopApi (DIRECT_KEYS.settings) composed in the renderer over its own core connection: desktop
// settings, activity rail pins, the markdown default view, notification preferences and conversation overrides, remote
// access, and the desktop events the main process used to forward (settings changed, provider models changed, rail pins,
// turn review, orchestration default, remote claims, remote access settings).
//
// Every call that was a desktop operation runs through the shared operation lane (shared/core-lanes), so the request is the one
// the main process sent for the same IPC call. Input checks live in the core, not here. Settings > Notifications' write is the
// one exception to the lane: it follows main/ipc-notifications.ts (the preference key `notifications.devices.<id>` with the
// write's own `announce: 'notifications'`), which the lane's operation does not carry.
//
// The two announcements the core sends (`ui/settings/changed`, `ui/providerModels/changed`) arrive as notifications
// (watchAnnouncements). The other events are what the held sections show changing: the `config` subtrees (`desktop` pins,
// `agent` orchestration default), the `reviewDiff` tell and the `remote` section (settings and claims), each compared with
// what the listener last heard.
import { remoteAccessInfoFromDescriptor } from '../../main/remote-access-window.ts';
import type { ConnectionStoreChange } from '../../main/protocol/connection';
import type { DesktopApi } from '../../shared/contract';
import { NOTIFICATION_PC_DEVICE_ID, type NotificationPreferencesState } from '../../shared/contract-notifications';
import { readOrchestrationModeChange, type OrchestrationModeChange } from '../../shared/orchestration-mode';
import { notificationPreferencesStateOf, notificationWriteMode } from '../../shared/notification-state';
import { PROVIDER_MODELS_EVENT } from '../../shared/provider-models';
import { SETTINGS_CHANGED_EVENT } from '../../shared/settings-changed';
import type { DirectKey } from '../../shared/desktop-api-split';
import { createOperationLane, watchAnnouncements } from '../../shared/core-lanes/desktop-operation-route';
import { readActivityRailPins } from '../../shared/core-lanes/section-reads';
import type { DirectContext } from './context.ts';
import { withDirectErrors } from './errors.ts';

type SettingsApi = Pick<DesktopApi, DirectKey<'settings'>>;

/** The orchestration default when the `agent` subtree names none or an unknown one (configured_orchestration_mode). */
const DEFAULT_ORCHESTRATION_MODE: OrchestrationModeChange['mode'] = 'balanced';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The host's OS as the operation lane wants it (it folds folder keys on Windows only; none of this group watches folders). */
function hostPlatform(): 'win32' | 'darwin' | 'linux' {
  const name = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /^win/i.test(name) ? 'win32' : /^mac/i.test(name) ? 'darwin' : 'linux';
}

export function createSettingsApi(ctx: DirectContext): SettingsApi {
  const { connection } = ctx;
  const lane = createOperationLane({
    protocol: connection,
    platform: hostPlatform(),
    host: { hostName: () => '' },
  });
  const op = <T>(name: string, args: unknown[] = []): Promise<T> => withDirectErrors(lane.invoke(name, args) as Promise<T>);

  /** The held value of `(section, key)`, or undefined while the core holds none. */
  const held = (section: string, key: string | null): unknown =>
    connection.snapshot().entries.find((entry) => entry.section === section && entry.key === key)?.value;
  /** True while sections a snapshot swapped in are still being announced: they are where things stand, not changes. */
  const announcingSnapshot = (): boolean =>
    Boolean((connection.client()?.store as { readonly owed?: unknown } | undefined)?.owed);
  /** Calls `onChange` for every change of the held `(section, key)`, and for a whole snapshot (which only resets where
   *  things stand); a snapshot's own announcements of the section are skipped. */
  const followSection = (
    section: string,
    key: string | null,
    onChange: (change: ConnectionStoreChange) => void
  ): (() => void) =>
    connection.onStoreChange((change) => {
      if (change.type === 'appSnapshot') return onChange(change);
      if (change.type !== 'section' || change.section !== section || (change.key ?? null) !== key) return;
      if (!announcingSnapshot()) onChange(change);
    });

  const announced = (name: string, listener: (value: never) => void): (() => void) =>
    watchAnnouncements(connection, (eventName, value) => {
      if (eventName === name) listener(value as never);
    });

  // ── Settings > Notifications (main/ipc-notifications.ts) ──
  const notificationState = async (): Promise<{ remote: unknown; notifications: unknown; supported: boolean }> => {
    const remote = await ctx.call('remoteAccess/state', {});
    const state = record(await ctx.call('notify/state', {}));
    return { remote, notifications: state.notifications ?? undefined, supported: state.supported === true };
  };
  const preferencesState = async (): Promise<NotificationPreferencesState> => {
    const { remote, notifications, supported } = await notificationState();
    return notificationPreferencesStateOf({
      remote,
      notifications,
      currentDeviceId: NOTIFICATION_PC_DEVICE_ID,
      pcCanNotify: supported,
      // The PC's name is the remote settings' name; the core's own default (the OS hostname) stands in when none was set.
      hostName: () => String(record(record(remote).settings).defaultName ?? ''),
    });
  };

  // ── events read from held sections ──
  const subscribePins: SettingsApi['subscribeActivityRailPins'] = (listener) => {
    let told = readActivityRailPins(connection.snapshot())?.revision ?? 0;
    return followSection('config', 'desktop', (change) => {
      const state = readActivityRailPins(connection.snapshot());
      if (change.type === 'appSnapshot') told = state?.revision ?? 0;
      else if (state && state.revision !== told) {
        told = state.revision;
        listener(state);
      }
    });
  };
  const subscribeTurnReview: NonNullable<SettingsApi['subscribeTurnReviewChanged']> = (listener) =>
    connection.onStoreChange((change) => {
      // A tell, not state: one the window was not there for (a snapshot) is not delivered.
      if (change.type === 'section' && change.section === 'reviewDiff' && !announcingSnapshot()) listener();
    });
  const configuredMode = (): OrchestrationModeChange['mode'] =>
    readOrchestrationModeChange({ mode: record(held('config', 'agent')).orchestrationMode })?.mode ??
    DEFAULT_ORCHESTRATION_MODE;
  const subscribeOrchestration: NonNullable<SettingsApi['subscribeOrchestrationModeChanged']> = (listener) => {
    let told = configuredMode();
    return followSection('config', 'agent', (change) => {
      const mode = configuredMode();
      if (change.type === 'appSnapshot') told = mode;
      else if (mode !== told) {
        told = mode;
        listener({ mode });
      }
    });
  };
  /** The whole `remote` value; a section over the inline limit is held as a stub and paged with `remoteAccess/state`. */
  const remoteValue = async (): Promise<Record<string, unknown> | null> => {
    const value = held('remote', null);
    if (value === undefined) return null;
    return record(value === null ? await ctx.call('remoteAccess/state', {}) : value);
  };
  /** Runs `read` on every change of the `remote` section, one at a time and in order. The first run only records where
   *  things stand. */
  const followRemote = (read: (value: Record<string, unknown>, first: boolean) => void): (() => void) => {
    let first = true;
    let queue: Promise<void> = Promise.resolve();
    const check = (): void => {
      queue = queue
        .then(async () => {
          const value = await remoteValue();
          if (!value) return;
          read(value, first);
          first = false;
        })
        .catch(() => undefined);
    };
    check();
    return followSection('remote', null, check);
  };
  const subscribeRemoteSettings: SettingsApi['subscribeRemoteAccessSettings'] = (listener) => {
    let told: string | null = null;
    return followRemote((value, first) => {
      const settings = JSON.stringify(value.settings ?? null);
      const changed = settings !== told;
      told = settings;
      if (changed && !first) listener(value.settings as never);
    });
  };
  const subscribeRemoteClaims: SettingsApi['subscribeRemoteClientClaim'] = (listener) => {
    let known = new Set<string>();
    return followRemote((value, first) => {
      const claims = Array.isArray(value.claims) ? value.claims.map(record) : [];
      const fresh = claims.filter((claim) => typeof claim.claimId === 'string' && !known.has(claim.claimId));
      known = new Set(claims.map((claim) => String(claim.claimId)));
      if (!first) for (const claim of fresh) listener(claim as never);
    });
  };

  const access = async (name: string, args: unknown[] = []) => remoteAccessInfoFromDescriptor(await op(name, args));

  return {
    readSettings: () => op('readSettings'),
    updateSetting: (key, enabled) => op('updateSetting', [key, enabled]),
    subscribeSettingsChanged: (listener) => announced(SETTINGS_CHANGED_EVENT, listener),
    readActivityRailPins: () => op('readActivityRailPins'),
    updateActivityRailPins: (pins, initializeIfMissing) => op('updateActivityRailPins', [pins, initializeIfMissing]),
    subscribeActivityRailPins: subscribePins,
    // The preload sent this and left the answer: a failed announcement is not the caller's.
    notifyProviderModelsChanged: (origin) => {
      void op('notifyProviderModelsChanged', [origin]).catch(() => undefined);
    },
    subscribeProviderModelsChanged: (listener) => announced(PROVIDER_MODELS_EVENT, listener),
    setNotificationVolume: (volume) => op('updateNotificationVolume', [volume]),
    setSessionRetention: (key, days) => op('updateSessionRetention', [key, days]),
    setBrowserPermissions: (policy) => op('updateBrowserPermissions', [policy]),
    setNotificationPreferences: (deviceId, patch) =>
      withDirectErrors(
        (async () => {
          const { remote, notifications } = await notificationState();
          const mode = notificationWriteMode(deviceId, remote, notifications);
          // Announced by the write itself, once, changed or not.
          await ctx.call('config/value/write', {
            path: `notifications.devices.${deviceId}`,
            value: patch,
            mode,
            announce: 'notifications',
          });
          return preferencesState();
        })()
      ),
    listConversationNotifications: () => op('listConversationNotifications'),
    setConversationNotification: (target, setting) => op('setConversationNotification', [target, setting]),
    subscribeTurnReviewChanged: subscribeTurnReview,
    subscribeOrchestrationModeChanged: subscribeOrchestration,
    readMarkdownDefaultView: () => op('readMarkdownDefaultView'),
    // The lane's route takes the user-data directory first (the main process's own path); the core needs none.
    writeMarkdownDefaultView: (view) => op('writeMarkdownDefaultView', ['', view]),
    rotateRemoteAccess: () => access('remoteAccessRotate'),
    revokeRemoteAccessClient: (clientId) => access('remoteAccessRevokeClient', [clientId]),
    setRemoteAccessEnabled: (enabled) => op('remoteAccessSetEnabled', [enabled]),
    setRemotePcName: (name) => op('remoteAccessSetName', [typeof name === 'string' ? name : '']),
    setRemoteClientAlias: async (clientId, alias) => {
      await op('remoteAccessSetClientAlias', [clientId, alias]);
    },
    resolveRemoteClientClaim: async (claimId, approved) =>
      (await op('remoteAccessResolveClaim', [claimId, approved])) === true,
    getRemotePairCode: (action) => op('remoteAccessPairCode', [action]),
    getRemoteAccessInfo: (options) => access('remoteAccessInfo', [options?.activate !== false]),
    subscribeRemoteClientClaim: subscribeRemoteClaims,
    getRemoteAccessSettings: () => op('remoteAccessSettings'),
    subscribeRemoteAccessSettings: subscribeRemoteSettings,
    listRemoteClientClaims: () => op('remoteAccessListClaims'),
  };
}
