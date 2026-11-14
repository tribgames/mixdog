import { type FillEngine, fillGuard, pageOfDocument } from './credential-autofill';

/**
 * Saved-login values for the core (Computer Use `fill_saved_login`). The core runs the fill and needs the
 * saved value for that one write, so the desktop hands it over once per fill, for an admitted fill only
 * (`host/browser/command` runtime-only actions, like `secret_precheck`):
 *
 * - `saved_login_admit {turn_id}`: the core accepted a fill of this session's agent turn. Answers whether
 *   Auto login is on; an off setting admits nothing.
 * - `saved_login_value {turn_id, origin, account, field}`: the exact-origin vault lookup of the account's
 *   username or password (the way `fill savedAccount` resolves it: for that origin only, a miss naming only
 *   masked labels). Refused unless the fill was admitted and Auto login is still on.
 * - `saved_login_check {turn_id, window_id, account, field}` / `saved_login_type {turn_id, window_id, account, field,
 *   text, expected}`: one worker step of the fill (Windows UIA: prove the browser window and its field, then write
 *   the value once), run through the computer host's own dispatch so its authorization, policy and last Auto login
 *   check apply. Answers the worker's response as it came (`{ok, error?, result?}`); for an admitted fill only.
 * - `saved_login_release {turn_id}`: the fill's turn settled; its admission, and those of older turns of the
 *   session, end.
 *
 * `saved_login_type` may carry `expect` (a `Precondition`) beside its `expected` target: the page the browser
 * window shows is then held to the state the core decided against, and the check runs in the same synchronous
 * step as the dispatch to the worker (nothing is awaited between them). In engine mode a write without `expect`
 * is refused with -32010 reason `document` and nothing is sent.
 *
 * The desktop keeps no value: the vault is read per lookup and the reply is the only copy it makes.
 */
export type SavedLoginField = 'username' | 'password';

export interface SavedLoginCredentials {
  useCredentialByAccount<T>(
    url: string,
    account: string,
    use: (credential: { username: string; password: string }) => Promise<T>
  ): Promise<T>;
}

export interface SavedLoginHostDeps {
  /** The `browserAutoSignIn` setting. */
  autoSignIn: () => boolean;
  credentials: SavedLoginCredentials;
  worker: SavedLoginWorkerPort;
  /** The engine lane's view of the pages; absent without the lane (a write then has no `expect` to hold to). */
  engine?: FillEngine;
  /** credential-vault.ts's pure text rules, loaded when first needed (that module needs Electron). */
  text: () => Promise<{ secureOrigin(value: string): string; maskedCredentialLabel(username: string): string }>;
}

/** The computer host: runs one `fill_saved_login` worker step and answers the worker's response. */
export interface SavedLoginWorkerPort {
  run(command: Record<string, unknown>): Promise<{ saved_login_response?: unknown }>;
}

export interface SavedLoginHostValue {
  enabled: true;
  value: string;
  /** The login's masked label. */
  label: string;
  origin: string;
}

const turnOf = (input: Record<string, unknown>): number => {
  const turn = Number(input.turn_id);
  return Number.isSafeInteger(turn) && turn >= 1 ? turn : 0;
};
const key = (sessionId: string, turn: number): string => `${sessionId}\u0000${turn}`;
/** The core's runtime id on the computer host's fill command (the host only needs one to scope the fill). */
const CORE_RUNTIME = 'core';
const unscoped = (): Error =>
  new Error('saved_login_unavailable: the request names no session and agent turn to scope its fill to; no input was sent');

export function createSavedLoginHost(deps: SavedLoginHostDeps) {
  const admitted = new Set<string>();
  return {
    admit(sessionId: string, input: Record<string, unknown>): { enabled: boolean } {
      const turn = turnOf(input);
      if (!sessionId || !turn) throw unscoped();
      if (!deps.autoSignIn()) return { enabled: false };
      admitted.add(key(sessionId, turn));
      return { enabled: true };
    },
    release(sessionId: string, input: Record<string, unknown>): { released: true } {
      const turn = turnOf(input);
      if (!sessionId || !turn) throw unscoped();
      for (const held of [...admitted]) {
        const [owner, at] = held.split('\u0000');
        if (owner === sessionId && Number(at) <= turn) admitted.delete(held);
      }
      return { released: true };
    },
    async step(sessionId: string, step: 'check' | 'type', input: Record<string, unknown>): Promise<unknown> {
      const turn = turnOf(input);
      if (!sessionId || !turn) throw unscoped();
      if (!admitted.has(key(sessionId, turn))) {
        throw new Error('saved_login_unavailable: the fill was not admitted for its session and turn; no input was sent');
      }
      const field = String(input.field || '');
      if (field !== 'username' && field !== 'password') {
        throw new Error('invalid_input: field must be username or password');
      }
      const account = typeof input.account === 'string' ? input.account.trim() : '';
      if (!account) throw new Error('invalid_input: account must name a saved login');
      const windowId = typeof input.window_id === 'string' ? input.window_id.trim() : '';
      if (!windowId) throw new Error('fill_saved_login requires an exact window_id before dispatch');
      const command: Record<string, unknown> = {
        action: 'fill_saved_login',
        session_id: sessionId,
        window_id: windowId,
        saved_account: account,
        field,
        delivery: 'foreground',
        turn_id: turn,
        runtime_id: CORE_RUNTIME,
        saved_login_step: step,
      };
      if (step === 'type') {
        if (typeof input.text !== 'string' || !input.text || !input.expected || typeof input.expected !== 'object') {
          throw new Error('invalid_input: a saved login write needs its value and the target that was checked');
        }
        command.saved_login_text = input.text;
        command.saved_login_expected = input.expected;
        // The page check and the dispatch below are one synchronous step: no await sits between them.
        fillGuard(deps.engine, pageOfDocument((input.expect as { documentId?: unknown } | undefined)?.documentId), input.expect)?.();
      }
      const reply = await deps.worker.run(command);
      if (!reply || typeof reply.saved_login_response !== 'object' || !reply.saved_login_response) {
        throw new Error('saved_login_unavailable: the computer host gave no worker answer; no input was sent');
      }
      return reply.saved_login_response;
    },
    check(sessionId: string, input: Record<string, unknown>): Promise<unknown> {
      return this.step(sessionId, 'check', input);
    },
    type(sessionId: string, input: Record<string, unknown>): Promise<unknown> {
      return this.step(sessionId, 'type', input);
    },
    async value(sessionId: string, input: Record<string, unknown>): Promise<SavedLoginHostValue> {
      const turn = turnOf(input);
      if (!sessionId || !turn) throw unscoped();
      if (!admitted.has(key(sessionId, turn))) {
        throw new Error('saved_login_unavailable: the fill was not admitted for its session and turn; no input was sent');
      }
      if (!deps.autoSignIn()) {
        throw new Error('saved_login_unavailable: Auto login is off in Settings (인증 관리); no input was sent');
      }
      const field = String(input.field || '');
      if (field !== 'username' && field !== 'password') {
        throw new Error('invalid_input: field must be username or password');
      }
      const account = typeof input.account === 'string' ? input.account.trim() : '';
      if (!account) throw new Error('invalid_input: account must name a saved login');
      const { secureOrigin, maskedCredentialLabel } = await deps.text();
      const origin = secureOrigin(String(input.origin || ''));
      if (!origin) throw new Error('saved_login_unavailable: the page origin is not a secure origin; no input was sent');
      const login = await deps.credentials.useCredentialByAccount(origin, account, async (credential) => ({
        username: credential.username,
        password: field === 'password' ? credential.password : '',
      }));
      return {
        enabled: true,
        value: field === 'password' ? login.password : login.username,
        label: maskedCredentialLabel(login.username),
        origin,
      };
    },
  };
}

export type SavedLoginHost = ReturnType<typeof createSavedLoginHost>;