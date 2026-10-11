// Display rules for the 6-digit pairing code: `482·917` and a `m:ss` countdown.

export function formatPairCode(code: string): string {
  return /^\d{6}$/u.test(code) ? `${code.slice(0, 3)}·${code.slice(3)}` : code;
}

export function remainingLabel(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Fraction of the code's life left, 0..1, for the progress bar. */
export function remainingFraction(expiresAt: number, now: number, lifetimeMs = 300_000): number {
  return Math.min(1, Math.max(0, (expiresAt - now) / lifetimeMs));
}
