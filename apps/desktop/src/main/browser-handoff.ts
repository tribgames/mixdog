/** One in-flight human handoff: a captcha, a 2FA prompt, or an identity check
 *  only the person at the keyboard can clear. The bookkeeping lives here,
 *  apart from Electron, because "exactly one answer wins" is the part worth
 *  testing on its own. */
export interface BrowserHandoffRequest {
  id: string;
  reason: string;
  url: string;
  requestedAt: number;
  expiresAt: number;
}

export interface BrowserHandoffTicket {
  request: BrowserHandoffRequest;
  /** Resolves true when the user reports the work done, false when the request
   *  was released instead (timeout, cancellation, shutdown). */
  settled: Promise<boolean>;
}

export const HANDOFF_MAX_REASON_CHARS = 200;

export class BrowserHandoffRegistry {
  private pending: {
    request: BrowserHandoffRequest;
    settle: (completed: boolean) => void;
  } | null = null;

  private issued = 0;

  get current(): BrowserHandoffRequest | null {
    return this.pending?.request ?? null;
  }

  /** One at a time: a second banner would leave the user guessing which
   *  request their answer belongs to. */
  begin(input: { reason: string; url: string; timeoutMs: number; now?: number }): BrowserHandoffTicket {
    if (this.pending) {
      throw new Error('another handoff is already waiting for the user; wait for it to finish');
    }
    const reason = String(input.reason || '').trim();
    if (!reason) throw new Error('handoff requires reason');
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    this.issued += 1;
    let settle: (completed: boolean) => void = () => undefined;
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const request: BrowserHandoffRequest = {
      id: `h${this.issued}`,
      reason: reason.slice(0, HANDOFF_MAX_REASON_CHARS),
      url: String(input.url || ''),
      requestedAt: now,
      expiresAt: now + Math.max(0, Math.trunc(input.timeoutMs)),
    };
    this.pending = { request, settle };
    return { request, settled };
  }

  /** The user answered. A stale or unknown id resolves nothing, so a late
   *  click on a banner that already closed cannot answer the next request. */
  resolve(id: string, completed: boolean): boolean {
    const pending = this.pending;
    if (!pending || pending.request.id !== id) return false;
    this.pending = null;
    pending.settle(completed);
    return true;
  }

  /** Timeout, cancellation, or shutdown: free the waiter without an answer.
   *  Without an id it releases whatever is pending. */
  release(id?: string): boolean {
    const pending = this.pending;
    if (!pending) return false;
    if (id && pending.request.id !== id) return false;
    this.pending = null;
    pending.settle(false);
    return true;
  }
}
