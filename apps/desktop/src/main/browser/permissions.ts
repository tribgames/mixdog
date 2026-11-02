import type { Session, WebContents, WebFrameMain } from 'electron';

type BrowserPermissionSession = Pick<
  Session,
  'setDevicePermissionHandler' | 'setPermissionCheckHandler' | 'setPermissionRequestHandler'
>;

type BrowserDeviceSession = BrowserPermissionSession & Pick<Session, 'on' | 'removeListener'>;

type HidDeviceInfo = Pick<Electron.HIDDevice, 'deviceId' | 'name'>;

type DeviceFrame = WebFrameMain;

/** A device a site may be connected to, as the chooser lists it. */
export interface BrowserPermissionDevice {
  id: string;
  name: string;
}

type PermissionFrame = Pick<WebFrameMain, 'url' | 'processId' | 'routingId' | 'executeJavaScript' | 'isDestroyed'>;

type PermissionGuest = Pick<WebContents, 'getURL' | 'once' | 'on' | 'removeListener' | 'isDestroyed'> & {
  mainFrame: PermissionFrame & Pick<WebFrameMain, 'framesInSubtree'>;
};

/** What a site can ask a person for. The words the prompt shows for each key
 *  are the pane's (translated there); anything not listed here is never
 *  offered to a person. */
const PROMPTED = new Set([
  'notifications',
  'geolocation',
  'clipboard-read',
  'midi',
  'midiSysex',
  'idle-detection',
  'top-level-storage-access',
  'window-management',
  'speaker-selection',
  'fileSystem',
  'media:video',
  'media:audio',
]);

/** Granted without asking, as Chrome grants them to every site: protected
 *  media playback, and element fullscreen (Chromium only asks after a user
 *  gesture, and Esc always leaves it), so a video's own fullscreen button works. */
const GRANTED_BY_DEFAULT = new Set(['mediaKeySystem', 'fullscreen']);

/** Granted on request without asking, as Chrome grants it to a frame that can
 *  already use its own cookies, which this partition never blocks (an
 *  embedded sign-in or reCAPTCHA frame). Only the top page holds it
 *  beforehand, as in Chrome; a frame still reads it as not granted. */
const STORAGE_ACCESS = 'storage-access';

/** Clipboard operations that reach beyond the page: reading, and writing
 *  without a gesture (which Chromium asks for as `clipboard-read` or
 *  `clipboard-sanitized-write`). Neither is ever granted from a remembered
 *  answer alone: the requesting frame needs a live user activation, which
 *  only a request (never a permission check) can verify. */
const NEEDS_ACTIVATION = new Set(['clipboard-read', 'clipboard-sanitized-write']);

/** The decision keys an engine permission name (as a `PermissionStatus`
 *  reports it) stands for. */
const ENGINE_KEYS: Record<string, string[]> = {
  audio_capture: ['media:audio'],
  video_capture: ['media:video'],
  clipboard_read: ['clipboard-read'],
  geolocation: ['geolocation'],
  idle_detection: ['idle-detection'],
  midi: ['midi', 'midiSysex'],
  notifications: ['notifications'],
  speaker_selection: ['speaker-selection'],
  'top-level-storage-access': ['top-level-storage-access'],
  'window-management': ['window-management'],
};

export interface PendingBrowserPermission {
  id: string;
  /** The frame asking. */
  origin: string;
  /** The top-level site it is embedded in (the same as `origin` for the page itself). */
  embedder: string;
  keys: string[];
  /** The frames that asked; a navigation of any of them withdraws the prompt. */
  frames: Set<string>;
  /** A device chooser (`hid`): the devices it offers, kept current while it
   *  waits. Its answer is one device, never remembered as a site decision. */
  devices?: BrowserPermissionDevice[];
  settle: Array<(granted: boolean, deviceId?: string) => void>;
}

export interface BrowserPermissionPrompt {
  id: string;
  origin: string;
  /** Only set when the asking frame is embedded in another site. */
  embedder?: string;
  keys: string[];
  devices?: BrowserPermissionDevice[];
}

export interface BrowserPermissionOptions {
  /** Whether every one of these frames has a live (transient) user activation. */
  userActivation?(frames: PermissionFrame[]): Promise<boolean>;
  /** Whether sites may ask to connect a HID device (the `browserHidDevices`
   *  setting, default off). Absent or false: every HID request is refused. */
  hidDevices?(): boolean;
  /** The page a requesting frame belongs to. */
  guestForFrame?(frame: DeviceFrame): PermissionGuest | null | undefined;
}

const frameId = (frame: Pick<WebFrameMain, 'processId' | 'routingId'>) => `${frame.processId}:${frame.routingId}`;

const deviceOf = (device: HidDeviceInfo): BrowserPermissionDevice => ({ id: device.deviceId, name: device.name || '' });

async function frameActivations(frames: PermissionFrame[]): Promise<boolean> {
  try {
    const active = await Promise.all(
      frames.map((frame) => frame.executeJavaScript('navigator.userActivation.isActive === true'))
    );
    return active.length > 0 && active.every((value) => value === true);
  } catch {
    return false;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Site permissions in the browser partition, decided the way Chrome decides
 * them: a site asks, a person answers in the pane, and the answer is
 * remembered for that site until the app quits. Nothing that reaches a
 * camera, microphone, location or device is ever granted without that
 * answer, and the agent has no way to give it. Requests that are not a
 * person's to grant here (external apps, screen capture, pointer lock,
 * USB, serial and Bluetooth devices) are refused outright. A HID device is
 * connected only while the `browserHidDevices` setting is on, and only the
 * one device a person picks in the pane's chooser.
 */
export function createBrowserPermissions(options: BrowserPermissionOptions = {}) {
  const userActivation = options.userActivation ?? frameActivations;
  const hidAllowed = () => options.hidDevices?.() === true;
  const decisions = new Map<string, boolean>();
  /** HID devices a person picked for an origin, until the app quits. */
  const deviceGrants = new Set<string>();
  const deviceGrant = (origin: string, deviceId: string) => `${origin}\n${deviceId}`;
  /** Device choosers still waiting, with their page: uninstall cancels them. */
  const choosers = new Map<PendingBrowserPermission, PermissionGuest>();
  const pending = new WeakMap<PermissionGuest, PendingBrowserPermission[]>();
  const watched = new WeakSet<PermissionGuest>();
  let serial = 0;
  /** Chrome keys a decision by the asking frame's origin and the top-level
   *  site embedding it, so a grant never carries to another origin or to the
   *  same origin embedded elsewhere. */
  const decisionKey = (embedder: string, origin: string, key: string) => `${embedder}\n${origin}\n${key}`;

  /** Settle a guest's open prompts as refused, without remembering it. With
   *  `frame`, only the prompts that frame asked. */
  function dropPending(guest: PermissionGuest, frame?: string): void {
    const queue = pending.get(guest) ?? [];
    const dropped = frame ? queue.filter((entry) => entry.frames.has(frame)) : queue;
    const kept = queue.filter((entry) => !dropped.includes(entry));
    if (kept.length) pending.set(guest, kept);
    else pending.delete(guest);
    for (const request of dropped) for (const settle of request.settle) settle(false);
  }

  /** A prompt belongs to the document of the frame that asked; that frame's
   *  navigation, its page's, or a closed page takes it away, as Chrome's would. */
  function watch(guest: PermissionGuest): void {
    if (watched.has(guest)) return;
    watched.add(guest);
    const onNavigation = (details: {
      isMainFrame?: boolean;
      isSameDocument?: boolean;
      frame?: Pick<WebFrameMain, 'processId' | 'routingId'> | null;
    }) => {
      if (!details || details.isSameDocument) return;
      if (details.isMainFrame || !details.frame) dropPending(guest);
      else dropPending(guest, frameId(details.frame));
    };
    guest.on('did-start-navigation', onNavigation as never);
    guest.once('destroyed', () => {
      guest.removeListener('did-start-navigation', onNavigation as never);
      dropPending(guest);
    });
  }

  /** What remembered answers say about a request: refused if any part was
   *  refused, granted once every part was granted, else still undecided. */
  function decided(embedder: string, origin: string, keys: string[]): boolean | undefined {
    const known = keys.map((key) => decisions.get(decisionKey(embedder, origin, key)));
    if (known.some((decision) => decision === false)) return false;
    return known.every((decision) => decision === true) ? true : undefined;
  }

  function request(
    guest: PermissionGuest,
    asker: { origin: string; embedder: string; frames: string[] },
    keys: string[],
    settle: (granted: boolean) => void
  ): void {
    const { origin, embedder } = asker;
    const known = decided(embedder, origin, keys);
    if (known !== undefined || guest.isDestroyed()) {
      settle(known === true);
      return;
    }
    watch(guest);
    const queue = pending.get(guest) ?? [];
    const same = queue.find(
      (entry) => entry.origin === origin && entry.embedder === embedder && entry.keys.join(',') === keys.join(',')
    );
    if (same) {
      same.settle.push(settle);
      for (const frame of asker.frames) same.frames.add(frame);
      return;
    }
    queue.push({
      id: `permission_${++serial}`,
      origin,
      embedder,
      keys,
      frames: new Set(asker.frames),
      settle: [settle],
    });
    pending.set(guest, queue);
  }

  /** The keys a request decides, or null for one nobody is asked about. */
  function requestKeys(permission: string, details: { mediaTypes?: string[] } | undefined): string[] | null {
    if (permission === 'media') {
      const kinds = (details?.mediaTypes || []).filter((kind) => kind === 'video' || kind === 'audio');
      return kinds.length ? kinds.map((kind) => `media:${kind}`) : null;
    }
    return PROMPTED.has(permission) ? [permission] : null;
  }

  /** The frames a request came from: the page itself, or the child frames
   *  whose last loaded URL is the one named. */
  function askingFrames(guest: PermissionGuest, details: { isMainFrame?: boolean; requestingUrl?: string }) {
    const main = guest.mainFrame;
    if (details.isMainFrame) return [main];
    return main.framesInSubtree.filter((frame) => frame !== main && frame.url === details.requestingUrl);
  }

  /** `navigator.hid.requestDevice()`: queued as a chooser a person answers
   *  in the pane, with the devices Chromium offers (blocklisted ones, such as
   *  security keys, are never among them). */
  function chooseHidDevice(
    event: { preventDefault(): void },
    details: { deviceList: HidDeviceInfo[]; frame: DeviceFrame | null },
    callback: (deviceId?: string | null) => void
  ): void {
    event.preventDefault();
    const frame = details.frame && !details.frame.isDestroyed() ? details.frame : null;
    const guest = frame ? options.guestForFrame?.(frame) : null;
    const origin = frame ? originOf(frame.origin) : '';
    const embedder = guest && !guest.isDestroyed() ? originOf(guest.getURL()) : '';
    const bad = (value: string) => !value || value === 'null';
    if (!hidAllowed() || !frame || !guest || bad(origin) || bad(embedder)) {
      callback();
      return;
    }
    watch(guest);
    const entry: PendingBrowserPermission = {
      id: `permission_${++serial}`,
      origin,
      embedder,
      keys: ['hid'],
      frames: new Set([frameId(frame)]),
      devices: details.deviceList.map(deviceOf),
      settle: [
        (granted, deviceId) => {
          choosers.delete(entry);
          if (granted && deviceId) deviceGrants.add(deviceGrant(origin, deviceId));
          callback(granted ? deviceId : undefined);
        },
      ],
    };
    choosers.set(entry, guest);
    pending.set(guest, [...(pending.get(guest) ?? []), entry]);
  }

  /** A device plugged in or out while a chooser of that frame waits. */
  function updateHidDevices(added: boolean, details: { device: HidDeviceInfo; frame: DeviceFrame | null }): void {
    const guest = details.frame ? options.guestForFrame?.(details.frame) : null;
    if (!details.frame || !guest) return;
    const asking = frameId(details.frame);
    for (const entry of pending.get(guest) ?? []) {
      if (!entry.devices || !entry.frames.has(asking)) continue;
      entry.devices = entry.devices.filter((device) => device.id !== details.device.deviceId);
      if (added) entry.devices.push(deviceOf(details.device));
    }
  }
  const onHidAdded = (_event: unknown, details: { device: HidDeviceInfo; frame: DeviceFrame | null }) =>
    updateHidDevices(true, details);
  const onHidRemoved = (_event: unknown, details: { device: HidDeviceInfo; frame: DeviceFrame | null }) =>
    updateHidDevices(false, details);

  return {
    install(session: BrowserDeviceSession): void {
      session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
        if (GRANTED_BY_DEFAULT.has(permission)) return true;
        if (NEEDS_ACTIVATION.has(permission)) return false;
        const origin = originOf(requestingOrigin);
        if (!origin || origin === 'null') return false;
        // Lets a page call `navigator.hid` at all; each device still needs a person's pick.
        if (permission === 'hid') return hidAllowed();
        if (permission === STORAGE_ACCESS) return details?.isMainFrame === true;
        const embedder = originOf(details?.embeddingOrigin ?? '') || origin;
        const key =
          permission === 'media' ? `media:${(details as { mediaType?: string } | undefined)?.mediaType}` : permission;
        return decisions.get(decisionKey(embedder, origin, key)) === true;
      });
      session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (GRANTED_BY_DEFAULT.has(permission) || permission === STORAGE_ACCESS) {
          callback(true);
          return;
        }
        const asked = details as { mediaTypes?: string[]; isMainFrame?: boolean; requestingUrl?: string };
        const keys = requestKeys(permission, asked);
        const origin = originOf(asked.requestingUrl ?? '');
        const embedder = originOf(webContents.getURL());
        const frames = askingFrames(webContents, asked);
        const bad = (value: string) => !value || value === 'null';
        if ((!keys && permission !== 'clipboard-sanitized-write') || bad(origin) || bad(embedder) || !frames.length) {
          callback(false);
          return;
        }
        const asker = { origin, embedder, frames: frames.map(frameId) };
        if (!NEEDS_ACTIVATION.has(permission)) {
          request(webContents, asker, keys as string[], callback);
          return;
        }
        void userActivation(frames).then((active) => {
          if (!active) callback(false);
          else if (keys) request(webContents, asker, keys, callback);
          else callback(true);
        });
      });
      // Electron consults only this handler once it is set, so the devices a
      // person picked are granted here; nothing else ever is.
      session.setDevicePermissionHandler(
        (details) =>
          details.deviceType === 'hid' &&
          hidAllowed() &&
          deviceGrants.has(deviceGrant(originOf(details.origin), (details.device as Electron.HIDDevice).deviceId))
      );
      session.on('select-hid-device', chooseHidDevice);
      session.on('hid-device-added', onHidAdded);
      session.on('hid-device-removed', onHidRemoved);
    },
    uninstall(session: BrowserDeviceSession): void {
      session.removeListener('select-hid-device', chooseHidDevice);
      session.removeListener('hid-device-added', onHidAdded);
      session.removeListener('hid-device-removed', onHidRemoved);
      clearBrowserPermissionHandlers(session);
      // A waiting chooser would otherwise leave the page's requestDevice() unresolved.
      for (const [entry, guest] of [...choosers]) {
        const queue = (pending.get(guest) ?? []).filter((other) => other !== entry);
        if (queue.length) pending.set(guest, queue);
        else pending.delete(guest);
        for (const settle of entry.settle) settle(false);
      }
    },
    /** Whether a person refused the page's origin one of the permissions an
     *  engine name stands for; an undecided permission is not refused. */
    refused(origin: string, engineName: string): boolean {
      return (ENGINE_KEYS[engineName] ?? []).some((key) => decisions.get(decisionKey(origin, origin, key)) === false);
    },
    /** The prompt the pane offers for a page, oldest first. */
    pending(guest: PermissionGuest): BrowserPermissionPrompt | undefined {
      const first = pending.get(guest)?.[0];
      if (!first) return undefined;
      return {
        id: first.id,
        origin: first.origin,
        ...(first.embedder === first.origin ? {} : { embedder: first.embedder }),
        keys: first.keys,
        ...(first.devices ? { devices: first.devices } : {}),
      };
    },
    /** A person's answer to the prompt `id`: remembered for the asking
     *  origin in its embedding site, and applied to every waiting request it
     *  decides. A device chooser is allowed only with one of its devices,
     *  `deviceId`, and settles only itself. False when that prompt is no
     *  longer the one shown or the device is not offered. */
    answer(guest: PermissionGuest, id: string, allow: boolean, deviceId?: string): boolean {
      const queue = pending.get(guest);
      const answered = queue?.[0];
      if (!queue || !answered || answered.id !== id) return false;
      if (answered.devices) {
        const chosen = allow ? answered.devices.find((device) => device.id === deviceId) : undefined;
        if (allow && !chosen) return false;
        queue.shift();
        if (queue.length) pending.set(guest, queue);
        else pending.delete(guest);
        for (const settle of answered.settle) settle(chosen !== undefined, chosen?.id);
        return true;
      }
      for (const key of answered.keys) decisions.set(decisionKey(answered.embedder, answered.origin, key), allow);
      const remaining: PendingBrowserPermission[] = [];
      for (const entry of queue) {
        const known = decided(entry.embedder, entry.origin, entry.keys);
        if (known === undefined) remaining.push(entry);
        else for (const settle of entry.settle) settle(known);
      }
      if (remaining.length) pending.set(guest, remaining);
      else pending.delete(guest);
      return true;
    },
  };
}

export type BrowserPermissions = ReturnType<typeof createBrowserPermissions>;

export function clearBrowserPermissionHandlers(session: BrowserPermissionSession): void {
  session.setPermissionCheckHandler(null);
  session.setPermissionRequestHandler(null);
  session.setDevicePermissionHandler(null);
}
