/**
 * Secret input: the one path a secret takes is renderer → this process →
 * target field. The card hands the value here (IPC `provideSecretInput`)
 * under the request id the runtime minted; the runtime then asks the browser
 * or computer bridge to fill that request, which takes the value exactly once.
 * The value never goes back to the runtime, the transcript, an approval
 * decision, a log, a notification or the clipboard. Each filled value is
 * remembered for its session so every later reply of that session is
 * redacted, and captures stay withheld while the field may still be focused.
 */

import { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } from '../shared/secret-slots';
import { beginComputerOperation } from './human-only-approval';

export const SECRET_INPUT_TIMEOUT_MS = 120_000;
/** A binding outlives the card's own wait (the runtime's 120 s) a little. */
const BINDING_TIMEOUT_MS = 180_000;
const MAX_SECRET_LENGTH = 4_096;
/** What replaces a filled secret wherever it later appears in tool output. */
export const REDACTED_MARKER = '[redacted]';
/** A session keeps at most this many filled secrets (the oldest leave first)
 *  and none shorter than this (they could not be told from page text). */
const MAX_SESSION_SECRETS = 64;
const MIN_REDACTED_LENGTH = 4;
const REQUEST_ID =/^secret_[A-Za-z0-9-]{8,80}$/;

/** What the agent hears about a fill (human-gate/requests.mjs HANDOFF_OUTCOMES). */
export type SecretFillOutcome = 'entered' | 'no_field' | 'page_changed' | 'blocked' | 'expired';
/** What a bound field is (requests.mjs SECRET_FORMS). */
export type SecretFieldForm = 'login' | 'password' | 'new-password' | 'otp';

/** The page a secret request was bound to when it was made. */
export interface SecretBinding {
  sessionId: string;
  pageId: string;
  origin: string;
  form: SecretFieldForm;
  /** The main frame's document when it was bound, as the browser reports it
   *  (frame id and CDP loader id, new for every document the frame loads;
   *  credential-autofill.ts mainDocumentOf): compared exactly, so a
   *  navigation since, even within the origin or to the same address, leaves
   *  nothing to fill. */
  document: string;
  /** The exact elements the value goes to, in order (the field, then its
   *  username, confirmation or one box per character): each one's CDP
   *  backend node id and input type at request time. A login takeover's
   *  saved-login binding has none. */
  targets?: Array<{ node: number; type: string }>;
}

/** The exact window and field a Computer Use secret request was bound to
 *  when it was made (the agent's window_id and ref; never a focused field). */
export interface ComputerSecretBinding {
  sessionId: string;
  windowId: string;
  ref: string;
}

/** A window id or field ref as the runtime validates it (ask-user-tool-defs.mjs). */
const TARGET_TOKEN = /^[\w.:#@-]+$/;

/** What replaces a Computer Use saved-login password wherever it later appears. */
export const SAVED_LOGIN_MARKER = '[saved login]';
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
 *  signaled), checked when its last connection detaches and whenever any
 *  owner attaches. An unknown answer keeps everything (fail closed). Without
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
 *  session until the filling turn settles (saved-login.ts, powershell-host.ts). */
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
/** The saved-login stores never evict: at capacity a new fill is refused before
 *  anything is written. The bound reuses the registry's existing secret bound
 *  (MAX_SESSION_SECRETS) rather than inventing another. */
export const MAX_SAVED_LOGIN_ENTRIES = MAX_SESSION_SECRETS;

export { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX };

/** A held entry and the timer that drops it when it expires. */
type Held<T> = { value: T; timer: ReturnType<typeof setTimeout> };

export function createSecretInputs(options: { timeoutMs?: number; bindingTimeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? SECRET_INPUT_TIMEOUT_MS;
  const bindingTimeoutMs = options.bindingTimeoutMs ?? BINDING_TIMEOUT_MS;
  const slots = new Map<string, Held<string>>();
  const bindings = new Map<string, Held<SecretBinding | ComputerSecretBinding>>();
  const sessionSecrets = new Map<string, Set<string>>();
  const focused = new Set<string>();
  // Saved-login password spellings (redacted for every session) and pixel
  // guards, each kept until its own turn settles or its owner is gone;
  // neither is ever evicted.
  const savedLoginValues: Array<SavedLoginTurn & { value: string }> = [];
  const pixelGuards: SavedLoginPixelGuard[] = [];
  // Each owner's process (id and OS creation time) and its attached
  // connections, owners whose process was proven ended (never admitted
  // again), and per owner and session the newest settled turn (no fill of it
  // or an older turn is admitted again).
  const owners = new Map<string, SavedLoginOwnerProcess & { connections: number }>();
  const goneOwners = new Set<string>();
  const settledThrough = new Map<string, number>();
  const ownerSession = (ownerId: string, sessionId: string) => `${ownerId}\u0000${sessionId}`;
  // Fills admitted and not yet finished: a retirement first waits for the
  // ones it covers, since a running fill may still arm a guard.
  const runningFills = new Set<SavedLoginTurn & { done: Promise<void> }>();

  // Every entry leaves memory on its own when it expires, whether or not
  // anything asks for it again; its timer never keeps the app alive and is
  // cleared as soon as the entry is used or dropped.
  const drop = <T>(map: Map<string, Held<T>>, id: string): void => {
    const held = map.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    map.delete(id);
  };
  // Retire every entry `covered` selects, once the running fills it selects
  // have finished. Callers first make sure no new fill it covers can be
  // admitted (a settled turn, a gone owner), so the drain is complete.
  const drainThenRetire = async (covered: (entry: SavedLoginTurn) => boolean): Promise<void> => {
    await Promise.all([...runningFills].filter(covered).map((fill) => fill.done));
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
  const validFill = (fill: SavedLoginTurn): boolean =>
    Boolean(fill.sessionId) && Number.isSafeInteger(fill.turnId) && fill.turnId > 0 && SAVED_LOGIN_OWNER.test(fill.ownerId);
  const sameFill = (a: SavedLoginTurn, b: SavedLoginTurn): boolean =>
    a.sessionId === b.sessionId && a.turnId === b.turnId && a.ownerId === b.ownerId;
  const hold = <T>(map: Map<string, Held<T>>, id: string, value: T, ms: number): void => {
    drop(map, id);
    const timer = setTimeout(() => {
      if (map.get(id)?.timer === timer) map.delete(id);
    }, ms);
    timer.unref?.();
    map.set(id, { value, timer });
  };

  return {
    /** Bind `requestId` to its page at request time (no value involved), for
     *  `ttlMs` (default: a little past the card's wait). */
    bind(requestId: string, binding: SecretBinding, ttlMs = bindingTimeoutMs): boolean {
      if (!REQUEST_ID.test(requestId)) return false;
      hold(bindings, requestId, { ...binding }, ttlMs);
      return true;
    },
    /** The page binding of `requestId`, left in place (the fill drops it with `discard`). */
    binding(requestId: string): SecretBinding | null {
      const held = bindings.get(requestId)?.value;
      return held && 'pageId' in held ? { ...held } : null;
    },
    /** Bind a Computer Use request to the exact window and field the agent
     *  named; false (nothing bound) unless both are plain tokens. */
    bindComputer(requestId: string, binding: ComputerSecretBinding): boolean {
      const { sessionId, windowId, ref } = binding;
      if (!REQUEST_ID.test(requestId) || !sessionId) return false;
      if (!TARGET_TOKEN.test(windowId) || windowId.length > 128 || !TARGET_TOKEN.test(ref) || ref.length > 64) {
        return false;
      }
      hold(bindings, requestId, { sessionId, windowId, ref }, bindingTimeoutMs);
      return true;
    },
    /** The window binding of `requestId`, left in place. */
    computerBinding(requestId: string): ComputerSecretBinding | null {
      const held = bindings.get(requestId)?.value;
      return held && 'windowId' in held ? { ...held } : null;
    },
    /** Whether the card handed a value for `requestId` (it is not taken). */
    has(requestId: string): boolean {
      return slots.has(requestId);
    },
    /** Drop every slot and the binding of `requestId` unused: the fill is
     *  over, or refused (blocked, page changed, no field). */
    discard(requestId: string): void {
      for (const id of [requestId, requestId + SECRET_USERNAME_SUFFIX, requestId + SECRET_SAVE_SUFFIX]) {
        drop(slots, id);
      }
      drop(bindings, requestId);
    },
    /** The card's value for `requestId`; false when the id or value is unusable. */
    provide(requestId: string, value: string): boolean {
      if (!REQUEST_ID.test(requestId) || typeof value !== 'string' || !value || value.length > MAX_SECRET_LENGTH) {
        return false;
      }
      hold(slots, requestId, value, timeoutMs);
      return true;
    },
    /** One-shot: the value is gone from the slot once taken. */
    take(requestId: string): string {
      const value = slots.get(requestId)?.value || '';
      drop(slots, requestId);
      return value;
    },
    /** Register `value` for redaction in every later reply of `sessionId`. */
    remember(sessionId: string, value: string): void {
      // Passwords, one-time codes and ask_user/agent-typed secrets only; a
      // username is no secret and is never registered. In memory only,
      // bounded: a value too short to tell from page text is
      // not kept, and the oldest of a session's values leaves first.
      if (!sessionId || value.length < MIN_REDACTED_LENGTH) return;
      const set = sessionSecrets.get(sessionId) ?? new Set<string>();
      set.delete(value);
      set.add(value);
      while (set.size > MAX_SESSION_SECRETS) set.delete(set.values().next().value as string);
      sessionSecrets.set(sessionId, set);
    },
    secretsOf(sessionId: string): string[] {
      return [...(sessionSecrets.get(sessionId) || [])];
    },
    redact(sessionId: string, text: string): string {
      let out = text;
      // Saved-login passwords first, longest first, so a value containing
      // another is replaced whole; each becomes the fixed marker, for every
      // session, never silent removal.
      const saved = [...new Set(savedLoginValues.map((entry) => entry.value))];
      for (const value of saved.sort((a, b) => b.length - a.length)) out = out.replaceAll(value, SAVED_LOGIN_MARKER);
      for (const secret of sessionSecrets.get(sessionId) || []) out = out.replaceAll(secret, REDACTED_MARKER);
      return out;
    },
    /** Register every spelling of a saved-login password for redaction in
     *  every session's later replies, as SAVED_LOGIN_MARKER, until `turn`
     *  settles. All or nothing: false (nothing registered) when a spelling is
     *  shorter than MIN_REDACTED_LENGTH or the store lacks room, and the
     *  caller then writes nothing. Never evicts. */
    rememberSavedLogin(turn: SavedLoginTurn, spellings: readonly string[]): boolean {
      if (!validFill(turn) || !spellings.length) return false;
      if (spellings.some((value) => value.length < MIN_REDACTED_LENGTH)) return false;
      const fresh = [...new Set(spellings)].filter(
        (value) => !savedLoginValues.some((entry) => entry.value === value && sameFill(entry, turn))
      );
      if (savedLoginValues.length + fresh.length > MAX_SAVED_LOGIN_ENTRIES) return false;
      const { sessionId, turnId, ownerId } = turn;
      for (const value of fresh) savedLoginValues.push({ sessionId, turnId, ownerId, value });
      return true;
    },
    /** Hold back pixels of `guard.windowId` and of every window of process
     *  `guard.pid` for every session until the guard's turn settles. Never
     *  replaces or evicts a guard: false (nothing armed) at capacity, and the
     *  caller then writes nothing. */
    armSavedLoginPixels(guard: SavedLoginPixelGuard): boolean {
      if (!validFill(guard) || !guard.windowId || !guard.pid) return false;
      const same = (held: SavedLoginPixelGuard) =>
        sameFill(held, guard) && held.windowId.toLowerCase() === guard.windowId.toLowerCase() && held.pid === guard.pid;
      if (pixelGuards.some(same)) return true;
      if (pixelGuards.length >= MAX_SAVED_LOGIN_ENTRIES) return false;
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
      const running = { sessionId: fill.sessionId, turnId: fill.turnId, ownerId: fill.ownerId, done: new Promise<void>((resolve) => (finish = resolve)) };
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
    /** The session ended: its secrets leave memory, and every turn of it any
     *  owner admitted a fill for is settled at once. */
    forget(sessionId: string): void {
      sessionSecrets.delete(sessionId);
      focused.delete(sessionId);
      const newest = new Map<string, number>();
      for (const entry of [...runningFills, ...pixelGuards, ...savedLoginValues]) {
        if (entry.sessionId === sessionId) newest.set(entry.ownerId, Math.max(newest.get(entry.ownerId) ?? 0, entry.turnId));
      }
      const through = new Map([...newest].map(([ownerId, turnId]) => [ownerId, markSettled(ownerId, sessionId, turnId)]));
      void drainThenRetire(
        (entry) => entry.sessionId === sessionId && entry.turnId <= (through.get(entry.ownerId) ?? 0)
      );
    },
    /** A secret field of `sessionId` may hold focus: captures are withheld. */
    armFocus(sessionId: string): void {
      focused.add(sessionId);
    },
    clearFocus(sessionId: string): void {
      focused.delete(sessionId);
    },
    focusArmed(sessionId: string): boolean {
      return focused.has(sessionId);
    },
  };
}

export type SecretInputs = ReturnType<typeof createSecretInputs>;

/** The window process's one registry (IPC, browser bridge and computer bridge share it). */
export const secretInputs = createSecretInputs();

/**
 * Computer Use, at request time (bridge `secret_bind`): bind the request to
 * the exact window and field ref the agent named. Answers 'bound', or
 * 'no_field' when that target is missing or not a plain token.
 */
export function bindComputerSecret(
  command: { session_id?: string; request_id?: string; ref?: string; window_id?: string },
  registry: SecretInputs = secretInputs
): { text: 'bound' | 'no_field' } {
  const bound = registry.bindComputer(String(command.request_id || ''), {
    sessionId: String(command.session_id || ''),
    windowId: String(command.window_id || ''),
    ref: String(command.ref || ''),
  });
  return { text: bound ? 'bound' : 'no_field' };
}

/** A computer input error that says its window or ref no longer exists. */
const STALE_TARGET = /stale_target|\bis stale\b|stale or invalid/i;

/**
 * Computer Use: type the request's value once into the window and field ref
 * it was bound to at request time (bindComputerSecret), never the focused
 * field, through the ordinary input path, discarding its reply (the capture
 * of a field holding the secret never leaves). The binding and the lock are
 * checked before the value is taken: a request never bound (no_field), a
 * target other than its binding (page_changed) or a held session (blocked)
 * drops the value and binding unused, never types it. Answers the outcome
 * and nothing else.
 */
export async function typeComputerSecret(
  command: { session_id?: string; request_id?: string; ref?: string; window_id?: string },
  execute: (command: Record<string, unknown>) => Promise<unknown>,
  registry: SecretInputs = secretInputs,
  assertFree: () => void = () => beginComputerOperation()()
): Promise<{ text: SecretFillOutcome }> {
  const sessionId = String(command.session_id || '');
  const requestId = String(command.request_id || '');
  const binding = registry.computerBinding(requestId);
  const refuse = (text: SecretFillOutcome) => {
    registry.discard(requestId);
    return { text };
  };
  if (!sessionId || !registry.has(requestId)) return refuse('expired');
  if (!binding) return refuse('no_field');
  if (binding.sessionId !== sessionId) return refuse('blocked');
  if (
    (command.window_id && command.window_id !== binding.windowId) ||
    (command.ref && command.ref !== binding.ref)
  ) {
    return refuse('page_changed');
  }
  try {
    assertFree();
  } catch {
    return refuse('blocked');
  }
  const value = registry.take(requestId);
  registry.discard(requestId);
  registry.remember(sessionId, value);
  registry.armFocus(sessionId);
  try {
    await execute({ action: 'type', text: value, session_id: sessionId, ref: binding.ref, window_id: binding.windowId });
    return { text: 'entered' };
  } catch (error) {
    // The window or field went away: the input path refuses a stale target
    // before typing (input-refs.ps1, session.ps1).
    return { text: STALE_TARGET.test(String((error as Error)?.message || error)) ? 'page_changed' : 'blocked' };
  }
}
