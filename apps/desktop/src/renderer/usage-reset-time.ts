export function formatUsageResetRemaining(remainingMs: number): string {
  const remaining = Number(remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return "";

  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes >= 24 * 60) {
    const totalHours = Math.ceil(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}d${hours ? ` ${hours}h` : ""}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type UsageResetDisplayState = "active" | "assumed-reset" | "unknown";

function usageResetDisplayState({
  resetAt,
  refreshedAt,
  verificationFailed,
  now = Date.now(),
}: {
  resetAt: number | null;
  refreshedAt: number;
  verificationFailed: boolean;
  now?: number;
}): UsageResetDisplayState {
  if (resetAt === null || resetAt > now) return "active";
  if (verificationFailed || refreshedAt >= resetAt) return "unknown";
  return "assumed-reset";
}

export function usageResetPresentation({
  percent,
  resetAt,
  refreshedAt,
  verificationFailed,
  now = Date.now(),
}: {
  percent: number | null;
  resetAt: number | null;
  refreshedAt: number;
  verificationFailed: boolean;
  now?: number;
}): { percent: number | null; resetTextOverride: "—" | null } {
  const state = usageResetDisplayState({
    resetAt,
    refreshedAt,
    verificationFailed,
    now,
  });
  if (state === "assumed-reset") return { percent: 0, resetTextOverride: "—" };
  if (state === "unknown") return { percent: null, resetTextOverride: "—" };
  return { percent, resetTextOverride: null };
}

export function nextUsageResetVerificationAt(
  resetAts: readonly number[],
  refreshedAt: number,
  failedResetAts: ReadonlySet<number>,
): number | null {
  let next: number | null = null;
  for (const resetAt of resetAts) {
    if (!Number.isFinite(resetAt) || resetAt <= refreshedAt || failedResetAts.has(resetAt)) continue;
    if (next === null || resetAt < next) next = resetAt;
  }
  return next;
}
