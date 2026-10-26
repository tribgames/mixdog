/**
 * The saved-login registry of the window process (secret-input.ts): the
 * runtime owners and their admitted fills, and what each fill set up (its
 * password spellings, redacted for every session, and its pixel guards), kept
 * until the filling turn settles or its owner is proven gone.
 */

import { redactBetweenMarkers, SAVED_LOGIN_MARKER } from './secret-markers';

/** One saved-login fill's scope: the runtime process that sent it (its owner
 *  id, src/runtime/computer-bridge/client.mjs SAVED_LOGIN_OWNER_ID), its
 *  session and that session's agent turn number. Everything the fill set up
 *  lives until that turn settles or its owner is gone, whichever comes first.
 *
 *  Ownership protocol: before its first fill a runtime opens an owner
 *  connection to the bridge (POST /owner with its owner id and process id,
 *  held open), and every fill and turn settlement names the owner. The
 *  desktop binds the owner to that exact process (id plus creation time, read
 *  from the OS at attach). A fill is admitted only while at least one of the
 *  owner's connections is attached and its turn has not settled.
 *
 *  A connection closing only detaches that connection: it is no proof the
 *  runtime died (a live runtime closes its old connection when the bridge it
 *  talks to changes). The owner's protection retires early only on an
 *  independent proof that its process ended (MixWin32.ProcessFate: the id is
 *  gone, names a process created at another time, or its process object is
 *  signaled), checked when its last connection detaches, whenever any owner
 *  attaches, and whenever a capture is about to be withheld by the pixel
 *  guard of a detached owner (so a process that ends after its connection
 *  dropped still releases the guard at the next capture; nothing polls). An
 *  unknown answer keeps everything (fail closed). Without
 *  that proof the protection stays until its turns settle; a runtime that died
 *  while its process cannot be read keeps its guards until the desktop exits.
 *  The process id is the runtime's own claim, trusted like the rest of its
 *  token-authenticated requests: it can only end that owner's own protection,
 *  which its turn settlements already can. */
export interface SavedLoginTurn {
  sessionId: string;
  turnId: number;
  ownerId: string;
}
/** After a saved-login password fill, no pixels of the filled browser window,
 *  nor of any window of the same browser process, leave the host for any
 *  session until the filling turn settles (saved-login.ts, host-authorization.ts). */
export interface SavedLoginPixelGuard extends SavedLoginTurn {
  windowId: string;
  pid: string;
}
/** An owner id as the runtime mints it (a random UUID). */
const SAVED_LOGIN_OWNER = /^[0-9a-f-]{36}$/;
/** The process an owner id is bound to: its id and its OS creation time
 *  (a FILETIME, as decimal text). */
export interface SavedLoginOwnerProcess {
  pid: number;
  created: string;
}
const ownerSession = (ownerId: string, sessionId: string) => `${ownerId}\u0000${sessionId}`;
const validFill = (fill: SavedLoginTurn): boolean =>
  Boolean(fill.sessionId) &&
  Number.isSafeInteger(fill.turnId) &&
  fill.turnId > 0 &&
  SAVED_LOGIN_OWNER.test(fill.ownerId);
const sameFill = (a: SavedLoginTurn, b: SavedLoginTurn): boolean =>
  a.sessionId === b.sessionId && a.turnId === b.turnId && a.ownerId === b.ownerId;

export function createSavedLoginRegistry() {
  // Saved-login password spellings (redacted for every session) and pixel
  // guards, each kept until its own turn settles or its owner is gone;
  // neither is ever evicted. Neither needs a count limit: they hold only the
  // fills still live, which the turn's settlement or the owner's proven end
  // retires.
  const savedLoginValues: Array<SavedLoginTurn & { value: string }> = [];
  const pixelGuards: SavedLoginPixelGuard[] = [];
  // Each owner's process (id and OS creation time) and its attached
  // connections, owners whose process was proven ended (never admitted
  // again), and per owner and session the newest settled turn (no fill of it
  // or an older turn is admitted again).
  const owners = new Map<string, SavedLoginOwnerProcess & { connections: number }>();
  const goneOwners = new Set<string>();
  const settledThrough = new Map<string, number>();
  // Fills admitted and not yet finished: a retirement first waits for the
  // ones it covers, since a running fill may still arm a guard.
  const runningFills = new Set<SavedLoginTurn & { done: Promise<void> }>();

  // Retire every entry `covered` selects, once the running fills it selects
  // have finished. Callers first make sure no new fill it covers can be
  // admitted (a settled turn, a gone owner), so the drain is complete.
  const drainThenRetire = async (covered: (entry: SavedLoginTurn) => boolean): Promise<void> => {
    // With none to wait for, the entries are gone before this returns.
    const running = [...runningFills].filter(covered);
    if (running.length) await Promise.all(running.map((fill) => fill.done));
    for (const list of [pixelGuards, savedLoginValues] as SavedLoginTurn[][]) {
      for (let index = list.length - 1; index >= 0; index--) if (covered(list[index])) list.splice(index, 1);
    }
  };
  // Mark `turnId` (and every older turn) of the owner's session settled, at
  // once, so a fill of it arriving after this point is refused.
  const markSettled = (ownerId: string, sessionId: string, turnId: number): number => {
    const key = ownerSession(ownerId, sessionId);
    const through = Math.max(settledThrough.get(key) ?? 0, turnId);
    settledThrough.set(key, through);
    return through;
  };

  return {
    /** `text` with every saved-login password replaced by SAVED_LOGIN_MARKER:
     *  longest first, so a value containing another is replaced whole; for
     *  every session, never silent removal. Markers already in `text`
     *  (secret-markers.ts) are left as they are. */
    redact(text: string): string {
      const saved = [...new Set(savedLoginValues.map((entry) => entry.value))].sort((a, b) => b.length - a.length);
      return redactBetweenMarkers(text, saved, SAVED_LOGIN_MARKER);
    },
    /** Register every spelling of a saved-login password for redaction in
     *  every session's later replies, as SAVED_LOGIN_MARKER, until `turn`
     *  settles, whatever their length. All or nothing: false (nothing
     *  registered) when `turn` is no valid fill or names no spelling, and the
     *  caller then writes nothing. Never evicts. An empty spelling hides
     *  nothing (replacing it would mark every character boundary) and is skipped. */
    rememberSavedLogin(turn: SavedLoginTurn, spellings: readonly string[]): boolean {
      if (!validFill(turn) || !spellings.length) return false;
      const fresh = [...new Set(spellings)].filter(
        (value) => value && !savedLoginValues.some((entry) => entry.value === value && sameFill(entry, turn))
      );
      const { sessionId, turnId, ownerId } = turn;
      for (const value of fresh) savedLoginValues.push({ sessionId, turnId, ownerId, value });
      return true;
    },
    /** Hold back pixels of `guard.windowId` and of every window of process
     *  `guard.pid` for every session until the guard's turn settles. Never
     *  replaces or evicts a guard: false (nothing armed) when `guard` names no
     *  valid fill, window or process, and the caller then writes nothing. */
    armSavedLoginPixels(guard: SavedLoginPixelGuard): boolean {
      if (!validFill(guard) || !guard.windowId || !guard.pid) return false;
      const same = (held: SavedLoginPixelGuard) =>
        sameFill(held, guard) && held.windowId.toLowerCase() === guard.windowId.toLowerCase() && held.pid === guard.pid;
      if (pixelGuards.some(same)) return true;
      pixelGuards.push({ ...guard });
      return true;
    },
    /** Every armed pixel guard, of every session. */
    savedLoginPixelGuards(): SavedLoginPixelGuard[] {
      return pixelGuards.map((guard) => ({ ...guard }));
    },
    /** One owner connection of runtime `ownerId`, whose process is `process`
     *  (SavedLoginTurn). Null when that owner was proven ended, or the id is
     *  already bound to another process. Call the returned function when the
     *  connection closes, whichever side closed it: it only detaches. */
    attachSavedLoginOwner(ownerId: string, process: SavedLoginOwnerProcess): (() => void) | null {
      if (!SAVED_LOGIN_OWNER.test(ownerId) || goneOwners.has(ownerId)) return null;
      if (!Number.isSafeInteger(process.pid) || process.pid < 1 || !/^[1-9]\d*$/.test(process.created)) return null;
      const known = owners.get(ownerId);
      if (known && (known.pid !== process.pid || known.created !== process.created)) return null;
      const owner = known ?? { pid: process.pid, created: process.created, connections: 0 };
      owner.connections += 1;
      owners.set(ownerId, owner);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        owner.connections = Math.max(0, owner.connections - 1);
      };
    },
    /** Owners with no attached connection, as their processes were bound. */
    detachedSavedLoginOwners(): Array<SavedLoginOwnerProcess & { ownerId: string }> {
      return [...owners]
        .filter(([, owner]) => owner.connections === 0)
        .map(([ownerId, { pid, created }]) => ({ ownerId, pid, created }));
    },
    /** The OS proved owner `ownerId`'s process ended: none of its turns can
     *  still run or settle, so all it set up retires once its running fills
     *  finish, and it is never admitted again. Refused (false) while any of
     *  its connections is still attached. */
    retireEndedSavedLoginOwner(ownerId: string): boolean {
      const owner = owners.get(ownerId);
      if (!owner || owner.connections > 0) return false;
      owners.delete(ownerId);
      goneOwners.add(ownerId);
      for (const key of [...settledThrough.keys()]) if (key.startsWith(`${ownerId}\u0000`)) settledThrough.delete(key);
      void drainThenRetire((entry) => entry.ownerId === ownerId);
      return true;
    },
    /** Admit one saved-login fill the moment the bridge accepts it, before any
     *  target preparation: its finish function (call it when the fill has
     *  ended, however it ended), or why it is refused (no attached owner, or
     *  its turn already settled). */
    admitSavedLoginFill(fill: SavedLoginTurn): (() => void) | string {
      if (!validFill(fill)) return 'the request names no runtime owner and agent turn to scope its protection to';
      if (!(owners.get(fill.ownerId)?.connections ?? 0)) return 'this runtime holds no owner connection to the bridge';
      if (fill.turnId <= (settledThrough.get(ownerSession(fill.ownerId, fill.sessionId)) ?? 0)) {
        return 'its agent turn has already ended';
      }
      let finish = () => {};
      const running = {
        sessionId: fill.sessionId,
        turnId: fill.turnId,
        ownerId: fill.ownerId,
        done: new Promise<void>((resolve) => (finish = resolve)),
      };
      runningFills.add(running);
      return () => {
        runningFills.delete(running);
        finish();
      };
    },
    /** Whether `fill` was admitted and has not finished. */
    savedLoginFillAdmitted(fill: SavedLoginTurn): boolean {
      return [...runningFills].some((running) => sameFill(running, fill));
    },
    /** The authoritative settlement of `turn` by its owner: from this moment
     *  no fill of that turn (or an older one of the owner's session) is
     *  admitted, and once those still running have finished, their pixel
     *  guards and password redaction retire. */
    settleSavedLoginTurn(turn: SavedLoginTurn): Promise<void> {
      if (!validFill(turn)) return Promise.resolve();
      const through = markSettled(turn.ownerId, turn.sessionId, turn.turnId);
      return drainThenRetire(
        (entry) => entry.ownerId === turn.ownerId && entry.sessionId === turn.sessionId && entry.turnId <= through
      );
    },
    /** The session ended: every turn of it any owner admitted a fill for is
     *  settled at once. */
    forget(sessionId: string): void {
      const newest = new Map<string, number>();
      for (const entry of [...runningFills, ...pixelGuards, ...savedLoginValues]) {
        if (entry.sessionId === sessionId)
          newest.set(entry.ownerId, Math.max(newest.get(entry.ownerId) ?? 0, entry.turnId));
      }
      const through = new Map(
        [...newest].map(([ownerId, turnId]) => [ownerId, markSettled(ownerId, sessionId, turnId)])
      );
      void drainThenRetire(
        (entry) => entry.sessionId === sessionId && entry.turnId <= (through.get(entry.ownerId) ?? 0)
      );
    },
  };
}
