// The PCs a browser or phone (a remote surface served by a relay) has
// connected to, for the top-bar PC switcher. Names and routes only — a route
// is a label, never a credential — kept in this origin's storage. Online state
// comes from the relay's presence probe.
import { DEVICE_STORAGE_KEY } from './remote-shim-state';

const SAVED_PCS_KEY = 'mixdog.savedPcs';
const MAX_SAVED = 16;
const ROUTE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/iu;

export interface SavedPc {
  deviceId: string;
  name: string;
  lastConnectedAt: number;
}

export function readSavedPcs(raw?: string | null): SavedPc[] {
  try {
    const parsed = JSON.parse(raw ?? localStorage.getItem(SAVED_PCS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    const pcs: SavedPc[] = [];
    for (const row of parsed as Array<Partial<SavedPc> | null>) {
      if (!row || typeof row.deviceId !== 'string' || !ROUTE_ID.test(row.deviceId)) continue;
      if (pcs.some((pc) => pc.deviceId === row.deviceId)) continue;
      pcs.push({
        deviceId: row.deviceId.toLowerCase(),
        name: typeof row.name === 'string' ? row.name.slice(0, 80) : '',
        lastConnectedAt: Number.isFinite(row.lastConnectedAt) ? Number(row.lastConnectedAt) : 0,
      });
    }
    return pcs.slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

/** Remember (or refresh) a PC; the newest is first. */
export function rememberPc(list: SavedPc[], pc: SavedPc): SavedPc[] {
  const existing = list.find((entry) => entry.deviceId === pc.deviceId);
  const merged = { ...pc, name: pc.name || existing?.name || '' };
  return [merged, ...list.filter((entry) => entry.deviceId !== pc.deviceId)].slice(0, MAX_SAVED);
}

/** Store the name a PC announced after authenticating, replacing an empty or
 *  stale saved label so the switcher never lists several nameless "PC" rows. */
export function savePcName(deviceId: string, rawName: string): void {
  const name = rawName.trim().slice(0, 80);
  if (!deviceId || !name) return;
  const list = readSavedPcs();
  const existing = list.find((pc) => pc.deviceId === deviceId);
  if (existing?.name === name) return;
  const next = existing
    ? list.map((pc) => (pc.deviceId === deviceId ? { ...pc, name } : pc))
    : rememberPc(list, { deviceId, name, lastConnectedAt: Date.now() });
  try {
    localStorage.setItem(SAVED_PCS_KEY, JSON.stringify(next));
  } catch {
    /* private storage */
  }
}

export function currentDeviceId(): string {
  const fromRoute = /^\/d\/([^/]+)/u.exec(location.pathname)?.[1] ?? '';
  if (ROUTE_ID.test(fromRoute)) return fromRoute.toLowerCase();
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export interface SwitcherPc {
  id: string;
  name: string;
  /** Null when the relay could not be asked. */
  online: boolean | null;
  lastConnectedAt: number | null;
  current: boolean;
  /** The main window's own PC (not a PC being driven remotely). */
  thisPc?: boolean;
  /** A window for this saved PC is open right now. */
  windowOpen?: boolean;
}

/** The current PC's name and every saved PC's online state, from the relay.
 *  Records the current PC as a side effect. */
export async function loadWebSwitcherPcs(doFetch: typeof fetch = fetch): Promise<SwitcherPc[]> {
  const deviceId = currentDeviceId();
  if (!deviceId) return [];
  let online: boolean | null = null;
  try {
    // The relay no longer serves the host name here (and throttles with 429):
    // only presence is read, and the saved name is kept as it is.
    const response = await doFetch(`/pair-code/support?deviceId=${encodeURIComponent(deviceId)}`);
    if (response.ok) {
      const body = (await response.json()) as { online?: unknown };
      online = body.online === true;
    }
  } catch {
    /* offline: keep what is saved */
  }
  const saved = rememberPc(readSavedPcs(), { deviceId, name: '', lastConnectedAt: Date.now() });
  try {
    localStorage.setItem(SAVED_PCS_KEY, JSON.stringify(saved));
  } catch {
    /* private storage */
  }
  let presence: Record<string, unknown> = {};
  try {
    const response = await doFetch('/pair-code/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: saved.map((pc) => pc.deviceId) }),
    });
    if (response.ok) presence = ((await response.json()) as { online?: Record<string, unknown> }).online ?? {};
  } catch {
    /* state unknown */
  }
  const onlineState = (id: string): boolean | null => {
    if (id === deviceId && online !== null) return online;
    return id in presence ? presence[id] === true : null;
  };
  return saved.map((pc) => ({
    id: pc.deviceId,
    name: pc.name,
    online: onlineState(pc.deviceId),
    lastConnectedAt: pc.lastConnectedAt || null,
    current: pc.deviceId === deviceId,
  }));
}
