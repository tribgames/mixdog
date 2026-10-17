import type { Session, WebContents, WebFrameMain } from 'electron';

type BrowserPermissionSession = Pick<
  Session,
  'setDevicePermissionHandler' | 'setPermissionCheckHandler' | 'setPermissionRequestHandler'
>;

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
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'speaker-selection',
  'fileSystem',
  'media:video',
  'media:audio',
]);

/** Granted without asking, as Chrome grants them to every site: protected
 *  media playback. */
const GRANTED_BY_DEFAULT = new Set(['mediaKeySystem']);

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
  'storage-access': ['storage-access'],
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
  settle: Array<(granted: boolean) => void>;
}

export interface BrowserPermissionPrompt {
  id: string;
  origin: string;
  /** Only set when the asking frame is embedded in another site. */
  embedder?: string;
  keys: string[];
}

export interface BrowserPermissionOptions {
  /** Whether every one of these frames has a live (transient) user activation. */
  userActivation?(frames: PermissionFrame[]): Promise<boolean>;
}

const frameId = (frame: Pick<WebFrameMain, 'processId' | 'routingId'>) => `${frame.processId}:${frame.routingId}`;

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
 * person's to grant here (external apps, screen capture, fullscreen, pointer
 * lock, attached devices) are refused outright.
 */
export function createBrowserPermissions(options: BrowserPermissionOptions = {}) {
  const userActivation = options.userActivation ?? frameActivations;
  const decisions = new Map<string, boolean>();
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

  return {
    install(session: BrowserPermissionSession): void {
      session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
        if (GRANTED_BY_DEFAULT.has(permission)) return true;
        if (NEEDS_ACTIVATION.has(permission)) return false;
        const origin = originOf(requestingOrigin);
        if (!origin || origin === 'null') return false;
        const embedder = originOf(details?.embeddingOrigin ?? '') || origin;
        const key =
          permission === 'media' ? `media:${(details as { mediaType?: string } | undefined)?.mediaType}` : permission;
        return decisions.get(decisionKey(embedder, origin, key)) === true;
      });
      session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (GRANTED_BY_DEFAULT.has(permission)) {
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
      session.setDevicePermissionHandler(() => false);
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
      };
    },
    /** A person's answer to the prompt `id`: remembered for the asking
     *  origin in its embedding site, and applied to every waiting request it
     *  decides. False when that prompt is no longer the one shown. */
    answer(guest: PermissionGuest, id: string, allow: boolean): boolean {
      const queue = pending.get(guest);
      const answered = queue?.[0];
      if (!queue || !answered || answered.id !== id) return false;
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
