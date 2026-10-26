/**
 * Saved-login sign-in for Computer Use: the login Browser Use signs in with
 * (its vault, account rules and Auto login setting) written into a username or
 * password field of the user's own browser window, with no prompt and no value
 * ever reaching the model. The safety is the host's checking. The worker
 * (runtime-saved-login.ps1) first proves the target: a Chrome or Edge
 * window whose live process image is signed by that vendor, in the foreground,
 * focus on a field of its top-level page (a password field for a password, an
 * editable text field for a username) and that page's HTTPS origin, which a
 * readable address bar must agree with. Only then is the login looked up, for
 * exactly that origin. The write step repeats every check after the dispatch
 * is authorized, re-reads the field, its document and origin last, and writes
 * the value once through the exact element's value pattern; there is no
 * keystroke fallback. Those UIA reads and the write are separate calls, not an
 * atomic compare-and-write inside the browser.
 *
 * Contract: the site receives the credential. A password is the protected
 * value: until the filling agent turn settles, its exact spellings are
 * redacted from everything model-facing (replies, errors, history,
 * accessibility text) for every session and pixels of that browser are
 * withheld. A username is an identifier, not a secret: it gets neither. A page
 * that redisplays or reflects the password in another form can still expose
 * it, and other programs running as the same Windows user are outside this
 * protection.
 */
import { type SavedLoginPixelGuard, type SavedLoginTurn, type SecretInputs, secretInputs } from '../../secret-input';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';

export type SavedLoginField = 'username' | 'password';
const SAVED_LOGIN_FIELDS: readonly string[] = ['username', 'password'];

/** One saved value for a checked page, with the only names the agent sees. */
export interface SavedLoginValue {
  value: string;
  /** The login's masked label (credential-vault.ts maskedCredentialLabel). */
  label: string;
  origin: string;
}

export interface SavedLoginVault {
  /** The `field` value of `account` (username or masked label) saved for the
   *  HTTPS origin of `url`; a miss throws, naming only masked labels. */
  value(url: string, account: string, field: SavedLoginField): Promise<SavedLoginValue>;
}

export interface SavedLogins {
  /** The desktop's Auto login setting (browserAutoSignIn). */
  enabled(): boolean;
  vault: SavedLoginVault;
}

/** One worker request. `beforeSend` runs after the dispatch was authorized and
 *  synchronously right before the request is written to the worker: the last
 *  host check. A write the worker already executed cannot be recalled. */
type NativeCall = (request: Record<string, unknown>, beforeSend?: () => void) => Promise<PowerShellResponse>;
type NativeResult = NonNullable<PowerShellResponse['result']>;

function errorText(error: unknown): string {
  return String((error as Error)?.message || error).replace(/\.$/, '');
}

/** The request's login and field, or the refusal that sends nothing: off
 *  Windows, with Auto login off, or without a saved account to use. */
export function assertSavedLoginAvailable(
  command: ComputerCommand,
  savedLogins: SavedLogins | undefined,
  platform: NodeJS.Platform = process.platform
): { savedLogins: SavedLogins; field: SavedLoginField; account: string; turn: SavedLoginTurn } {
  if (platform !== 'win32') {
    throw new Error('saved_login_unavailable: saved logins are filled on Windows only for now; no input was sent');
  }
  if (!savedLogins?.enabled()) {
    throw new Error('saved_login_unavailable: Auto login is off in Settings (인증 관리); no input was sent');
  }
  const field = String(command.field || '');
  if (!SAVED_LOGIN_FIELDS.includes(field)) {
    throw new Error(
      "invalid_input: field must be username or password; one-time codes, passkeys, security keys and app approvals are the user's step (ask_user takeover)"
    );
  }
  const account = typeof command.saved_account === 'string' ? command.saved_account.trim() : '';
  if (!account) {
    throw new Error('invalid_input: saved_account must name a saved login');
  }
  if (!String(command.window_id || '').trim()) {
    throw new Error('fill_saved_login requires an exact window_id before dispatch');
  }
  // The runtime names itself (its owner id) and the agent turn; the fill's
  // protection lives until that turn settles or that runtime is gone, so a
  // fill it cannot scope is not made.
  const turnId = Number(command.turn_id);
  const ownerId = typeof command.runtime_id === 'string' ? command.runtime_id : '';
  if (!Number.isSafeInteger(turnId) || turnId < 1 || !ownerId) {
    throw new Error(
      'saved_login_unavailable: the request names no runtime and agent turn to scope its protection to; no input was sent'
    );
  }
  return {
    savedLogins,
    field: field as SavedLoginField,
    account,
    turn: { sessionId: String(command.session_id || ''), turnId, ownerId },
  };
}

/**
 * The capture gate after a saved-login password fill: while any session's turn
 * holds a guard, no pixels (capture, capture-after, zoom; any session) of the
 * filled window or of any window of the same browser process leave the host,
 * and no full-screen pixels at all. A window whose process cannot be read is
 * refused too (fail closed). Accessibility reads (`ax`) carry no pixels and
 * their text is redacted of the exact password, so they pass. Guards lift when
 * the filling turn settles, or when the OS proves its owner runtime's process
 * ended: a capture about to be withheld by the guards of owners with no
 * attached connection first reconciles those owners (`fate`, see
 * reconcileSavedLoginOwners), so a runtime that died after its connection
 * dropped never leaves a guard stuck. Only the guards that would withhold
 * this capture are looked at, only detached owners are asked, and an unknown
 * answer keeps the guard.
 */
export async function assertSavedLoginPixelsAllowed(
  command: ComputerCommand,
  windowId: string,
  windowPid: (windowId: string) => Promise<string | undefined>,
  registry: SecretInputs = secretInputs,
  fate?: SavedLoginProcessFate
): Promise<void> {
  if (String(command.mode || '') === 'ax' || !registry.savedLoginPixelGuards().length) return;
  const target = String(windowId || '').toLowerCase();
  const sameWindow = (guard: SavedLoginPixelGuard): boolean => guard.windowId.toLowerCase() === target;
  const readPid = async (): Promise<string | undefined> => {
    try {
      return await windowPid(windowId);
    } catch {
      return undefined;
    }
  };
  // The live guards that withhold this capture: all of them for a full-screen
  // capture or a window whose process cannot be read, else the ones of that
  // window or of its browser process. The process is read at most once.
  let pid: Promise<string | undefined> | undefined;
  const withholding = async (): Promise<SavedLoginPixelGuard[]> => {
    const guards = registry.savedLoginPixelGuards();
    if (!target || guards.every(sameWindow)) return guards;
    pid ??= readPid();
    const processId = await pid;
    return processId ? guards.filter((guard) => sameWindow(guard) || guard.pid === processId) : guards;
  };
  let held = await withholding();
  if (held.length && fate) {
    // Looked at again whoever retired the owner: a concurrent capture sharing
    // the same OS answer may have.
    await reconcileSavedLoginOwners(fate, registry, new Set(held.map((guard) => guard.ownerId)));
    held = await withholding();
  }
  if (held.length) {
    throw new Error(
      'capture_withheld: pixels of a browser a saved-login password was filled into are withheld until the end of this agent turn; read it with mode "ax" or capture in a later turn'
    );
  }
}

/** The OS's answer about one runtime process: `ended` only when it proves the
 *  process (that id and creation time) is gone (bridge-server-contract.ts). */
export type SavedLoginProcessFate = (process: { pid: number; created: string }) => Promise<{ state: string }>;

/** Owners' OS answers still pending, per registry: every reconcile that asks
 *  about an owner meanwhile (concurrent captures, an owner event) shares the
 *  one worker call instead of making its own. */
const pendingFates = new WeakMap<SecretInputs, Map<string, Promise<string>>>();

function readOwnerState(
  fate: SavedLoginProcessFate,
  registry: SecretInputs,
  owner: { ownerId: string; pid: number; created: string }
): Promise<string> {
  const reads = pendingFates.get(registry) ?? new Map<string, Promise<string>>();
  pendingFates.set(registry, reads);
  const pending = reads.get(owner.ownerId);
  if (pending) return pending;
  const read = (async () => {
    try {
      return (await fate({ pid: owner.pid, created: owner.created })).state;
    } catch {
      return 'unknown'; // unknown keeps it
    }
  })().finally(() => reads.delete(owner.ownerId));
  reads.set(owner.ownerId, read);
  return read;
}

/** Retire the saved-login protection of every detached owner (only those in
 *  `only` when given) whose process the OS proves ended (secret-input.ts
 *  SavedLoginTurn); a running or unknown answer keeps it. Event-driven, never
 *  polled: the bridge calls it as an owner connection detaches and as any
 *  owner attaches, and a capture about to be withheld by a detached owner's
 *  guard calls it (assertSavedLoginPixelsAllowed). One OS call per owner,
 *  bounded by the worker's own limit. */
export async function reconcileSavedLoginOwners(
  fate: SavedLoginProcessFate,
  registry: SecretInputs = secretInputs,
  only?: ReadonlySet<string>
): Promise<void> {
  for (const owner of registry.detachedSavedLoginOwners()) {
    if (only && !only.has(owner.ownerId)) continue;
    if ((await readOwnerState(fate, registry, owner)) === 'ended') registry.retireEndedSavedLoginOwner(owner.ownerId);
  }
}

/** A worker answer that wrote nothing, as this action's reply. */
function asSavedLoginReply(response: PowerShellResponse): PowerShellResponse {
  const result: NativeResult = { ...response.result, action: 'fill_saved_login' };
  delete result.saved_login_target;
  return { ...response, result };
}

/** The browser-read target the check returns, as this host reads it. */
interface SavedLoginTarget {
  origin?: unknown;
  window_id?: unknown;
  pid?: unknown;
}

/**
 * Check the browser window, look the login up for the origin it shows, and
 * have the worker write it into the checked field. `call` sends one authorized
 * request to the session's worker. Before a password is sent: Auto login is
 * re-proven after the vault await, every spelling of it is registered for
 * redaction and the pixel guard is armed, both scoped to this agent turn and
 * refused (nothing written) when either cannot be. The Auto login setting is
 * proven once more after the dispatch is authorized, right before the request
 * is written. Once the value was sent, a failure is "possibly written" and
 * never retried. The fill must have been admitted when the bridge accepted it
 * (secret-input.ts admitSavedLoginFill), so its turn's settlement waits for it.
 */
export async function fillSavedLogin(
  command: ComputerCommand,
  savedLogins: SavedLogins | undefined,
  call: NativeCall,
  options: { registry?: SecretInputs; platform?: NodeJS.Platform; assertRunnable?: () => void } = {}
): Promise<PowerShellResponse> {
  const { registry = secretInputs, platform = process.platform, assertRunnable } = options;
  const { field, account, turn } = assertSavedLoginAvailable(command, savedLogins, platform);
  const { sessionId } = turn;
  if (!registry.savedLoginFillAdmitted(turn)) {
    throw new Error(
      'saved_login_unavailable: the fill was not admitted by the bridge for its runtime and turn; no input was sent'
    );
  }
  const checked = await call({ action: 'saved_login_check', field, text: null });
  if (!checked.ok) {
    throw new Error(checked.error || 'saved_login_refused: the browser window could not be checked; no input was sent');
  }
  const target = checked.result?.saved_login_target as SavedLoginTarget | undefined;
  // Activation was refused or the foreground moved: the answer says so.
  if (!target || typeof target.origin !== 'string') return asSavedLoginReply(checked);
  assertRunnable?.();
  let saved: SavedLoginValue;
  try {
    saved = await assertSavedLoginAvailable(command, savedLogins, platform).savedLogins.vault.value(
      target.origin,
      account,
      field
    );
  } catch (error) {
    throw new Error(`saved_login_unavailable: ${errorText(error)}; no input was sent`);
  }
  // The worker's origin and the vault's (secureOrigin) must agree exactly.
  if (saved.origin !== target.origin) {
    throw new Error(
      'saved_login_refused: the page origin could not be matched exactly to the saved login; no input was sent'
    );
  }
  assertRunnable?.();
  assertSavedLoginAvailable(command, savedLogins, platform);
  if (field === 'password') {
    // The exact password, without line breaks, and as a JSON reply would
    // spell either: all must be registered, or nothing is written.
    const spellings = [saved.value, saved.value.replace(/[\r\n]+/g, '')].flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
    ]);
    if (!registry.rememberSavedLogin(turn, spellings)) {
      throw new Error(
        'saved_login_refused: the password could not be registered for redaction (too short to tell from page text, or too many fills still held until their turns settle); no input was sent'
      );
    }
    const guard = { ...turn, windowId: String(target.window_id || ''), pid: String(target.pid || '') };
    if (!registry.armSavedLoginPixels(guard)) {
      throw new Error(
        'saved_login_refused: too many saved-login fills are holding captures back until their turns settle; no input was sent'
      );
    }
  }
  const redact = (text: string) => registry.redact(sessionId, text);
  let sent = false;
  let written: PowerShellResponse;
  try {
    written = await call({ action: 'saved_login_type', field, text: saved.value, expected: target }, () => {
      assertRunnable?.();
      assertSavedLoginAvailable(command, savedLogins, platform);
      sent = true;
    });
  } catch (error) {
    if (!sent) throw new Error(redact(errorText(error)));
    throw new Error(
      `saved_login_unconfirmed: the saved ${field} was sent but no clear answer came back (${redact(errorText(error))}); it may have been written and is not retried`
    );
  }
  if (!written.ok) {
    throw new Error(
      redact(
        String(
          written.error ||
            'saved_login_unconfirmed: the worker gave no answer; the value may have been written and is not retried'
        )
      )
    );
  }
  if (typeof written.result?.code === 'string' && written.result.code) return asSavedLoginReply(written);
  return {
    ...written,
    result: {
      ...written.result,
      action: 'fill_saved_login',
      text:
        field === 'password'
          ? `filled the saved password of ${saved.label} into the focused field on ${saved.origin}; the site receives it and it stays out of your results, though a page that redisplays it can expose it; pixels of this browser are withheld until this turn ends`
          : `filled the saved username of ${saved.label} into the focused field on ${saved.origin}; a username is an identifier and is not hidden from you`,
      saved_login: { account: saved.label, origin: saved.origin, field },
    },
  };
}
