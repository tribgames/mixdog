// This PC's permission for a server to spend its model accounts.
//
// A server connection's model sends run only under a grant this PC created
// itself, from a trusted user action in that server's window: submitting a
// prompt or new task, sending a follow-up or queued item, resuming or
// prioritizing queued work, allowing a tool or answering a question, a slash command
// that runs a turn, or the notice's "Keep allowing". The connection observes
// those in the window's own requests (connections/trusted-action-client); its
// IPC handlers accept them only from the window's main frame. Nothing the
// server sends — its session snapshots included — creates or renews a grant.
//
// A grant lasts `grantMinutes` after the last trusted action and ends early
// once its cumulative calls or tokens (counted here, from the provider's own
// usage) reach their limits. Without a grant, server work that runs without the
// user (schedules, webhooks, background agents) may spend only when the host
// allows it, under its own budget of calls per hour and tokens per day.
//
// Tokens are only known once a call ends, so each admitted send holds a token
// reservation against its budget while it runs and settles to its actual usage
// when it ends (a call with no reported usage is charged its reservation).
// Concurrent calls therefore cannot jointly overshoot a budget by more than one
// call's usage beyond its own reservation.

import type { DesktopCapability } from '../shared/contract';

export interface ModelProxyGrantPolicy {
  /** A grant ends this long after the last trusted action. */
  grantMinutes: number;
  /** Cumulative model calls one grant allows. */
  grantCalls: number;
  /** Cumulative tokens (provider usage) one grant allows. */
  grantTokens: number;
  /** Without a grant, sends may run on the background budget. */
  allowBackground: boolean;
  backgroundCallsPerHour: number;
  backgroundTokensPerDay: number;
}

export const MODEL_PROXY_GRANT_DEFAULTS: Readonly<ModelProxyGrantPolicy> = Object.freeze({
  grantMinutes: 120,
  grantCalls: 2_000,
  grantTokens: 20_000_000,
  allowBackground: false,
  backgroundCallsPerHour: 120,
  backgroundTokensPerDay: 5_000_000,
});

/** Tokens a send holds against its budget while it runs. */
export interface ModelProxyTokenReservation {
  /** Held per call: this much, or what remains unheld when that is less. */
  perCall: number;
  /** A send is refused when less than this remains unheld (capped at the
   *  budget itself, so a small budget still admits a call). */
  minimum: number;
}

export const MODEL_PROXY_TOKEN_RESERVATION: Readonly<ModelProxyTokenReservation> = Object.freeze({
  perCall: 250_000,
  minimum: 4_096,
});

/** The per-host overrides as saved (ssh-host-store validates them). */
export interface ModelProxyGrantSettings {
  grantMinutes?: number;
  grantCalls?: number;
  grantTokens?: number;
  allowBackgroundModelUse?: boolean;
  backgroundCallsPerHour?: number;
  backgroundTokensPerDay?: number;
}

/** The policy of a host's saved settings: each absent field its default. */
export function modelProxyGrantPolicy(settings: ModelProxyGrantSettings | undefined): ModelProxyGrantPolicy {
  const defaults = MODEL_PROXY_GRANT_DEFAULTS;
  return {
    grantMinutes: settings?.grantMinutes ?? defaults.grantMinutes,
    grantCalls: settings?.grantCalls ?? defaults.grantCalls,
    grantTokens: settings?.grantTokens ?? defaults.grantTokens,
    allowBackground: settings?.allowBackgroundModelUse === true,
    backgroundCallsPerHour: settings?.backgroundCallsPerHour ?? defaults.backgroundCallsPerHour,
    backgroundTokensPerDay: settings?.backgroundTokensPerDay ?? defaults.backgroundTokensPerDay,
  };
}

/** Service requests of a server window that are trusted actions. Each one
 *  starts or continues work the user asked for in that window. */
export const MODEL_USE_TRUSTED_REQUESTS = [
  'submitNewTask',
  // Prompts, follow-ups and queued items, question answers included.
  'submitToSession',
  // Allowing a tool only; a denial is no trusted action.
  'resolveToolApprovalForSession',
  // Carries the conversation into a new session (optionally compacted).
  'inheritSession',
  'continueSessionInModel',
  'scheduleQuotaResume',
] as const;

/** Capabilities that are trusted actions: queued work moved up, the slash
 *  commands that call the model (`/compact`, `/goal`, a `/btw` side question),
 *  and a schedule run by hand. */
export const MODEL_USE_TRUSTED_CAPABILITIES: ReadonlySet<DesktopCapability> = new Set<DesktopCapability>([
  'prioritizeQueued',
  'compact',
  'askSide',
  'goalControl',
  'runScheduleNow',
]);

/** Why a send found no permission: no grant yet, the grant expired or used up
 *  its calls or tokens, or (background allowed) the background budget is spent. */
export type ModelProxyGrantEnd = 'none' | 'expired' | 'calls' | 'tokens' | 'background-calls' | 'background-tokens';

export type ModelProxyAdmission =
  | {
      ok: true;
      lane: 'grant' | 'background';
      /** Tokens held for this call until it settles. */
      reserved: number;
      /** The call ended: frees its reservation and charges `tokens` (the
       *  provider's usage), or the reservation itself when the provider
       *  reported none (undefined). Only the first settle or cancel counts. */
      settle(tokens: number | undefined): void;
      /** The call never reached the provider: frees its call and reservation. */
      cancel(): void;
    }
  | { ok: false; reason: ModelProxyGrantEnd };

export interface ModelProxyGrantView {
  active: boolean;
  /** When the open grant ends without another trusted action; null without one. */
  expiresAt: number | null;
  calls: number;
  /** Tokens charged to the grant by calls that ended. */
  tokens: number;
  /** Tokens held by the grant's calls still running. */
  reserved: number;
}

export interface ModelProxyGrants {
  /** A trusted action: opens a grant, or extends the open one. True when it opened one. */
  trust(): boolean;
  /** Takes one send under the grant, else under the background budget. */
  admit(): ModelProxyAdmission;
  view(): ModelProxyGrantView;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Tokens a provider result's usage reports: input and output, plus the cache
 *  reads and writes when the adapter reports input without them. Undefined
 *  when it reports no input or output count at all. */
export function usageTokens(usage: unknown, inputExcludesCache: boolean): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const fields = usage as Record<string, unknown>;
  const reported = (key: string): boolean => typeof fields[key] === 'number' && Number.isFinite(fields[key]);
  if (!reported('inputTokens') && !reported('outputTokens')) return undefined;
  const count = (key: string): number => {
    const value = Number(fields[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return (
    count('inputTokens') +
    count('outputTokens') +
    (inputExcludesCache ? count('cachedTokens') + count('cacheWriteTokens') : 0)
  );
}

/** The tokens a new call may hold against `budget`, or null when too little
 *  remains unheld to admit one. */
function holdable(
  budget: number,
  charged: number,
  reserved: number,
  reservation: ModelProxyTokenReservation
): number | null {
  const remaining = budget - charged - reserved;
  if (remaining < Math.max(1, Math.min(reservation.minimum, budget))) return null;
  return Math.min(reservation.perCall, remaining);
}

export function createModelProxyGrants({
  policy,
  now = Date.now,
  reservation = MODEL_PROXY_TOKEN_RESERVATION,
}: {
  /** Read on every check, so a changed host setting applies at once. */
  policy: () => ModelProxyGrantPolicy;
  now?: () => number;
  reservation?: ModelProxyTokenReservation;
}): ModelProxyGrants {
  let grant: { lastTrustedAt: number; calls: number; tokens: number; reserved: number } | null = null;
  // Background lane: start times of the last hour's calls, the last day's
  // charges, and the tokens its running calls hold.
  let backgroundCalls: number[] = [];
  let backgroundSpends: Array<{ at: number; tokens: number }> = [];
  let backgroundReserved = 0;

  const endOf = (current: ModelProxyGrantPolicy, time: number): ModelProxyGrantEnd | null => {
    if (!grant) return 'none';
    if (time >= grant.lastTrustedAt + current.grantMinutes * 60_000) return 'expired';
    if (grant.calls >= current.grantCalls) return 'calls';
    if (grant.tokens >= current.grantTokens) return 'tokens';
    return null;
  };

  /** One admitted call: settles or cancels once. */
  const admission = (
    lane: 'grant' | 'background',
    reserved: number,
    finish: (charge: number, ran: boolean) => void
  ): ModelProxyAdmission => {
    let open = true;
    return {
      ok: true,
      lane,
      reserved,
      settle: (tokens) => {
        if (!open) return;
        open = false;
        finish(tokens === undefined ? reserved : Math.max(0, tokens), true);
      },
      cancel: () => {
        if (!open) return;
        open = false;
        finish(0, false);
      },
    };
  };

  return {
    trust() {
      const time = now();
      if (grant && endOf(policy(), time) === null) {
        grant.lastTrustedAt = time;
        return false;
      }
      grant = { lastTrustedAt: time, calls: 0, tokens: 0, reserved: 0 };
      return true;
    },
    admit() {
      const current = policy();
      const time = now();
      const end = endOf(current, time);
      if (end === null && grant) {
        const held = grant;
        const reserve = holdable(current.grantTokens, held.tokens, held.reserved, reservation);
        if (reserve !== null) {
          held.calls += 1;
          held.reserved += reserve;
          return admission('grant', reserve, (charge, ran) => {
            held.reserved -= reserve;
            held.tokens += charge;
            if (!ran) held.calls -= 1;
          });
        }
        // Running calls hold what is left. The grant is still the permission
        // in force, so the background budget does not stand in for it.
        return { ok: false, reason: 'tokens' };
      }
      if (!current.allowBackground) return { ok: false, reason: end ?? 'none' };
      backgroundCalls = backgroundCalls.filter((at) => time - at < HOUR_MS);
      backgroundSpends = backgroundSpends.filter((entry) => time - entry.at < DAY_MS);
      if (backgroundCalls.length >= current.backgroundCallsPerHour) return { ok: false, reason: 'background-calls' };
      const spent = backgroundSpends.reduce((sum, entry) => sum + entry.tokens, 0);
      const reserve = holdable(current.backgroundTokensPerDay, spent, backgroundReserved, reservation);
      if (reserve === null) return { ok: false, reason: 'background-tokens' };
      backgroundCalls.push(time);
      backgroundReserved += reserve;
      return admission('background', reserve, (charge, ran) => {
        backgroundReserved -= reserve;
        if (charge > 0) backgroundSpends.push({ at: now(), tokens: charge });
        if (!ran) {
          const index = backgroundCalls.lastIndexOf(time);
          if (index >= 0) backgroundCalls.splice(index, 1);
        }
      });
    },
    view() {
      const current = policy();
      const active = endOf(current, now()) === null;
      return {
        active,
        expiresAt: active && grant ? grant.lastTrustedAt + current.grantMinutes * 60_000 : null,
        calls: grant?.calls ?? 0,
        tokens: grant?.tokens ?? 0,
        reserved: grant?.reserved ?? 0,
      };
    },
  };
}
