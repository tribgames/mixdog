/** A stop request is not a stopped worker. Failed cleanup remains latched
 * until the host is replaced; neither resume nor a cosmetic reset can clear it. */
export class ComputerCleanupBarrier {
  private readonly pending = new Map<string, number>();
  private failed = false;
  get blocked(): boolean { return this.pending.size > 0 || this.failed; }
  get state(): 'pending' | 'failed' | 'ready' {
    return this.pending.size > 0 ? 'pending' : this.failed ? 'failed' : 'ready';
  }
  has(sessionId: string): boolean { return this.pending.has(sessionId); }
  assertClear(): void {
    if (this.blocked) {
      throw new Error('computer_cleanup_pending: worker termination and input cleanup must be confirmed before new input or resume; unconfirmed cleanup requires restarting the host');
    }
  }
  begin(sessionId: string): (confirmed: boolean) => void {
    this.pending.set(sessionId, (this.pending.get(sessionId) || 0) + 1);
    let done = false;
    return (confirmed) => {
      if (done) return;
      done = true;
      if (!confirmed) this.failed = true;
      const remaining = (this.pending.get(sessionId) || 1) - 1;
      if (remaining) this.pending.set(sessionId, remaining);
      else this.pending.delete(sessionId);
    };
  }
}
