import { Pin } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { PaneSurfaceGate } from "./PaneSurfaceGate";
import { t } from "./i18n";
import { ProviderIcon } from "./provider-display";
import {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  subscribeUsageDashboard,
  USAGE_DASHBOARD_CACHE_KEY,
  withUsageTimeout,
  type UsageApi,
  type UsageRecord,
} from "./usage-dashboard-store";
import { displayUsagePercent } from "./usage-percent";

/** The cache key is owned by the shared store; this alias keeps the historical
 *  import site for the sidebar surface. */
export const SIDEBAR_USAGE_CACHE_KEY = USAGE_DASHBOARD_CACHE_KEY;
const SIDEBAR_CODEX_RESET_ATTEMPT_KEY = "mixdog.desktop.codex-reset-attempt.v1";
const SIDEBAR_CODEX_RESET_TIMEOUT_MS = 90_000;

const SUBSCRIPTIONS = [
  { key: "codex", label: "Codex", provider: "openai-oauth" },
  { key: "claude", label: "Claude", provider: "anthropic-oauth" },
  { key: "grok", label: "Grok", provider: "grok-oauth" },
  { key: "cursor", label: "Cursor", provider: "cursor-oauth" },
  { key: "opencode-go", label: "OpenCode Go", provider: "opencode-go" },
] as const;

type Subscription = typeof SUBSCRIPTIONS[number];

function record(value: unknown): UsageRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UsageRecord
    : {};
}

function rows(value: unknown): UsageRecord[] {
  const dashboard = record(value);
  return Array.isArray(dashboard.rows) ? dashboard.rows.map(record) : [];
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed)
    ? null
    : parsed;
}

function timestamp(value: unknown): number | null {
  const parsed = number(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

function subscriptionRow(dashboard: unknown, subscription: Subscription): UsageRecord {
  return rows(dashboard).find((row) => {
    const id = String(row.id || "").toLowerCase();
    const label = String(row.label || "").toLowerCase();
    const group = String(row.group || "").toLowerCase();
    if (subscription.key === "opencode-go") {
      return id === "opencode-go" || label.includes("opencode go");
    }
    if (subscription.key === "cursor") {
      return id === "cursor-oauth" || label.includes("cursor oauth");
    }
    if (group !== "oauth") return false;
    if (subscription.key === "codex") return /openai|codex/.test(`${id} ${label}`);
    if (subscription.key === "claude") return /anthropic|claude/.test(`${id} ${label}`);
    return /grok|xai/.test(`${id} ${label}`);
  }) || {};
}

function quotaWindows(row: UsageRecord): UsageRecord[] {
  return Array.isArray(row.windows) ? row.windows.map(record) : [];
}

function quotaWindowKey(window: UsageRecord, index: number): string {
  return String(window.id || window.window || window.period || window.label || `window:${index}`);
}

function resetCreditKey(credit: UsageRecord, index: number): string {
  return String(credit.id || credit.creditId
    || (timestamp(credit.expiresAt) ? `expires:${timestamp(credit.expiresAt)}` : `credit:${index}`));
}

function subscriptionConnected(row: UsageRecord): boolean {
  return row.authenticated === true || quotaWindows(row).length > 0;
}

function windowLabel(window: UsageRecord): string {
  const label = String(window.label || "Quota").trim();
  if (/^(?:w|wk|week|weekly)$/i.test(label)) return "W";
  if (/^(?:mo|mon|month|monthly)$/i.test(label)) return "M";
  return label.toUpperCase();
}

function usedPercent(window: UsageRecord): number | null {
  const value = number(window.usedPct);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

/** Rail pin mode (user: 핀모드): one entry per brand that has quota data —
 *  its icon plus the final quota window's usage, picked by longest period:
 *  monthly (M) → weekly (7D/W) → daily/hourly. Unknown windows fall back to
 *  the provider's final entry. */
export interface UsagePinEntry {
  key: string;
  label: string;
  provider: string;
  percent: number;
}

const PIN_WINDOW_PRIORITY = [
  /^(?:M|MO|MON|MONTH|MONTHLY)$/i,
  /^(?:7D|W|WK|WEEK|WEEKLY)$/i,
  /^(?:\d+H|\d+D|D|DAY|DAILY)$/i,
];

function pinPercent(windows: UsageRecord[], preferredLabel = ""): number | null {
  const candidates = windows.flatMap((window) => {
    const percent = usedPercent(window);
    return percent === null ? [] : [{ label: String(window.label || "").trim(), percent }];
  });
  if (!candidates.length) return null;
  if (preferredLabel) {
    const preferred = candidates.find((candidate) => candidate.label.toLowerCase() === preferredLabel.toLowerCase());
    if (preferred) return preferred.percent;
  }
  for (const pattern of PIN_WINDOW_PRIORITY) {
    const hit = candidates.find((candidate) => pattern.test(candidate.label));
    if (hit) return hit.percent;
  }
  return candidates[candidates.length - 1].percent;
}

export function usagePinEntries(dashboard: unknown): UsagePinEntry[] {
  return SUBSCRIPTIONS.flatMap((subscription) => {
    const percent = pinPercent(
      quotaWindows(subscriptionRow(dashboard, subscription)),
      subscription.provider === "cursor-oauth" ? "Basic" : "",
    );
    if (percent === null) return [];
    return [{
      key: subscription.key,
      label: subscription.label,
      provider: subscription.provider,
      percent,
    }];
  });
}

// Tidied schedule copy (user: 리셋시간 문구 정리): lowercase duration units
// read as time, not as quota-window labels (5H/W/M stay uppercase).
function resetSchedule(value: unknown): { state: "due" | "soon" | "in" | ""; time: string } {
  const resetAt = timestamp(value);
  if (resetAt === null) return { state: "", time: "" };
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return { state: "due", time: "" };
  const totalHours = Math.ceil(remaining / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return { state: "in", time: `${days}d${hours ? ` ${hours}h` : ""}` };
  if (totalHours > 0) return { state: "in", time: `${totalHours}h` };
  return { state: "soon", time: "" };
}

function resetText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === "due") return t("Reset due");
  if (schedule.state === "in") return t("Resets in {{time}}", { time: schedule.time });
  return schedule.state === "soon" ? t("Resets soon") : "";
}

function resetExpiryText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === "due") return t("Expiry due");
  if (schedule.state === "in") return t("Expires in {{time}}", { time: schedule.time });
  return schedule.state === "soon" ? t("Expires soon") : "";
}

/** Every quota window carries its OWN schedule (user: 각각 항목마다 초기화시간
 *  개별로 하나씩): a compact duration that closes the meter row after the
 *  percentage, with the full sentence kept in the row tooltip.
 *  The duration units are notation, not prose, so they stay untranslated like
 *  the 5d/13h reading itself. */
function resetShortText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === "due") return "now";
  if (schedule.state === "in") return schedule.time;
  return schedule.state === "soon" ? "<1h" : "—";
}

function resetCredits(row: UsageRecord): UsageRecord {
  return record(row.resetCredits);
}

function availableResetCredits(value: UsageRecord): UsageRecord[] {
  const availableCount = Math.max(0, Math.floor(number(value.availableCount) || 0));
  const credits = (Array.isArray(value.availableCredits) ? value.availableCredits : [])
    .map(record)
    .sort((left, right) =>
      (timestamp(left.expiresAt) ?? Number.POSITIVE_INFINITY)
      - (timestamp(right.expiresAt) ?? Number.POSITIVE_INFINITY));
  while (credits.length < availableCount) credits.push({});
  return credits.slice(0, availableCount);
}

function createResetAttemptId(): string {
  const bytes = new Uint8Array(16);
  if (typeof window.crypto?.getRandomValues === "function") {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codexResetAttempt(offerRevision: string): string {
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY) || "null"));
    if (stored.offerRevision === offerRevision && typeof stored.idempotencyKey === "string") {
      return stored.idempotencyKey;
    }
  } catch {
    // A corrupt retry record is replaced with a fresh scoped attempt below.
  }
  const idempotencyKey = createResetAttemptId();
  try {
    window.localStorage.setItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY, JSON.stringify({
      offerRevision,
      idempotencyKey,
    }));
  } catch {
    // In-memory completion remains safe for this window when storage is unavailable.
  }
  return idempotencyKey;
}

function clearCodexResetAttempt(offerRevision: string): void {
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY) || "null"));
    if (stored.offerRevision === offerRevision) {
      window.localStorage.removeItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY);
    }
  } catch {
    // The next attempt replaces an unreadable record.
  }
}

export function SidebarUsage({
  api = window.mixdogDesktop,
  sidebarOpen = true,
  pinned = false,
  onTogglePin,
}: {
  api?: UsageApi;
  sidebarOpen?: boolean;
  /** Rail pin mode: the header toggle swaps the rail's pie glyph for the
   *  per-brand icon + % stack (user: 핀모드). */
  pinned?: boolean;
  onTogglePin?(): void;
}) {
  // The popup mounts and unmounts with the flyout; the snapshot, the in-flight
  // request and the refresh cadence all live in the shared store, so opening
  // paints the last known rows immediately and only revalidates.
  const snapshot = useSyncExternalStore(subscribeUsageDashboard, getUsageDashboardSnapshot);
  const dashboard = snapshot.dashboard;
  const rowsPresent = rows(dashboard).length > 0;
  // A seedless first paint announces LOADING until the store reports a live
  // result or a final unavailable state. Painting "Not connected" while the
  // very first request is still outstanding claimed an answer nobody has yet.
  // Cached rows always win: revalidation never downgrades them to Loading.
  const awaitingFirstUsage = !rowsPresent
    && (snapshot.status === "idle" || snapshot.status === "loading");
  const [resetConfirming, setResetConfirming] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const section = useRef<HTMLElement>(null);

  // One cadence for the renderer: the rail holds it too, so a popup remount
  // never restarts the five-minute timer and never re-requests.
  useEffect(() => holdUsageDashboardCadence(api), [api]);

  // Opening revalidates a stale snapshot only (fresh data inside the TTL paints
  // as-is, an in-flight request is shared); closing clears reset confirmation.
  useEffect(() => {
    if (sidebarOpen) {
      void refreshUsageDashboard(api);
    } else {
      setResetConfirming(null);
      setResetNotice("");
    }
  }, [api, sidebarOpen]);

  // Preserve the provider's individual expiry rows. The consume endpoint does
  // not accept a credit id, so every Use action safely means "consume one
  // currently available credit"; the refreshed provider list decides which
  // concrete row remains afterward.
  const codexRow = subscriptionRow(dashboard, SUBSCRIPTIONS[0]);
  const codexResetCredits = resetCredits(codexRow);
  const codexResetCount = Math.max(0, Math.floor(number(codexResetCredits.availableCount) || 0));
  const codexResetRows = availableResetCredits(codexResetCredits);
  const codexResetKeys = codexResetRows.map(resetCreditKey);
  const codexResetKeySignature = codexResetKeys.join("\u0000");
  const codexResetOffer = String(codexResetCredits.offerRevision || "");
  useEffect(() => {
    if (resetConfirming && !codexResetKeys.includes(resetConfirming)) {
      setResetConfirming(null);
    }
  }, [codexResetKeySignature, resetConfirming]);
  const consumeCodexReset = async () => {
    if (!codexResetOffer || codexResetCount < 1 || resetting ||
      typeof api?.invokeCapability !== "function") return;
    const idempotencyKey = codexResetAttempt(codexResetOffer);
    setResetting(true);
    setResetNotice("");
    try {
      const response = await withUsageTimeout(api.invokeCapability({
        capability: "consumeCodexRateLimitResetCredit",
        args: [{
          expectedOfferRevision: codexResetOffer,
          idempotencyKey,
        }],
      }), SIDEBAR_CODEX_RESET_TIMEOUT_MS, window);
      const result = record(response?.value);
      // Authoritative provider vocabulary (oauth-usage.mjs): every consume that
      // the runtime recognises carries one of these, plus a rebuilt dashboard.
      const outcome = String(result.outcome || "");
      const authoritative = result.status === "offerChanged"
        || outcome === "reset" || outcome === "alreadyRedeemed"
        || outcome === "nothingToReset" || outcome === "noCredit";
      if (!authoritative) {
        // Unrecognised outcome: the durable idempotency key SURVIVES so a retry
        // reuses this operation instead of spending a second credit, and the
        // surface says so.
        setResetNotice(t("Reset could not be confirmed. Retrying is safe."));
        return;
      }
      // The OUTCOME settles the redeem; the rebuilt dashboard is a courtesy
      // payload. When it arrives it lands in the shared snapshot and its cache
      // (not popup-local state); when the runtime's refresh budget expired,
      // the store revalidates instead of calling a spent credit unconfirmed.
      if (!publishUsageDashboard(result.dashboard)) {
        void refreshUsageDashboard(api, { force: true });
      }
      clearCodexResetAttempt(codexResetOffer);
      setResetConfirming(null);
      setResetNotice(result.status === "offerChanged"
        ? t("Reset availability changed. Review the latest Codex usage.")
        : outcome === "reset"
        ? t("Rate limits reset.")
        : outcome === "alreadyRedeemed"
        ? t("Reset already applied.")
        : outcome === "nothingToReset"
        ? t("No eligible rate-limit window is exhausted.")
        : t("No reset credit is available."));
    } catch (cause) {
      // Keep the durable idempotency key: retrying an unknown provider outcome
      // must reuse the same operation rather than spend a second credit.
      console.error("Codex reset-credit consume failed:", cause);
      const reason = cause instanceof Error && cause.message ? cause.message.trim() : "";
      setResetNotice(reason
        ? t("Reset could not be confirmed ({{reason}}). Retrying is safe.", { reason })
        : t("Reset could not be confirmed. Retrying is safe."));
    } finally {
      setResetting(false);
    }
  };

  return (
    <section ref={section} className="sidebar-usage" aria-label={t("Usage")}>
      <header className="sidebar-usage-heading">
        <b>{t("Usage")}</b>
        {onTogglePin && <button type="button"
          className={`sidebar-usage-pin ${pinned ? "is-active" : ""}`}
          aria-pressed={pinned}
          aria-label={pinned ? t("Unpin usage from the rail") : t("Pin usage to the rail")}
          title={pinned ? t("Unpin usage from the rail") : t("Pin usage to the rail")}
          onClick={onTogglePin}>
          {/* Diagonal pushpin; the
              tilt comes from the CSS rotate on .sidebar-usage-pin svg. */}
          <Pin size={14} aria-hidden="true" />
        </button>}
      </header>
      <PaneSurfaceGate ready={!awaitingFirstUsage} label={t("Loading usage…")}>
      <div className="sidebar-usage-content">
      <div id="sidebar-usage-list" className="sidebar-usage-list">
        {/* Flat roster: header (icon · name · soonest reset) with
            EVERY quota window inline beneath — nothing left to drill into. */}
        {SUBSCRIPTIONS.map((subscription) => {
          const row = subscriptionRow(dashboard, subscription);
          const windows = quotaWindows(row);
          const available = Object.keys(row).length > 0;
          const connected = subscriptionConnected(row);
          return <div className="sidebar-usage-row" key={subscription.key}
            data-usage-provider={subscription.key}>
            <span className="sidebar-usage-line">
              <span className="sidebar-usage-provider-icon">
                <ProviderIcon provider={subscription.provider} />
              </span>
              <b>{subscription.label}</b>
              {windows.length === 0 && <small>{!available && awaitingFirstUsage ? t("Loading…")
                : connected ? t("Connected") : t("Not connected")}</small>}
            </span>
            <span className="sidebar-usage-meters">
              {windows.map((window, index) => {
                const percent = usedPercent(window);
                const displayedPercent = displayUsagePercent(percent);
                const tone = percent !== null && percent >= 90 ? " tone-danger"
                  : percent !== null && percent >= 70 ? " tone-warning" : "";
                const resetSentence = resetText(window.resetAt);
                return <span className={`sidebar-usage-meter${tone}`}
                  key={quotaWindowKey(window, index)}>
                  <small>{windowLabel(window)}</small>
                  <i><i style={{ width: `${percent ?? 0}%` }} /></i>
                  <b>{displayedPercent === null ? "—" : `${displayedPercent}%`}</b>
                  <em title={resetSentence || undefined}>{resetShortText(window.resetAt)}</em>
                </span>;
              })}
              {windows.length === 0 && <span className="sidebar-usage-meter sidebar-usage-meter-empty">
                <small>{!available && awaitingFirstUsage ? t("Loading…")
                  : connected ? t("No current quota window") : t("Connect to load usage")}</small>
              </span>}
            </span>
          </div>;
        })}
      </div>
      {/* Hide the reset-ticket surface when the account has none available. */}
      {codexResetOffer && codexResetCount > 0 && <section className="sidebar-usage-reset-credit">
        <header className="sidebar-usage-reset-heading">
          <b>{t("Codex reset credits")}</b>
          <small>{t("{{count}} available", { count: codexResetCount })}</small>
        </header>
        {codexResetRows.length > 0 && <div className="sidebar-usage-reset-list">
          {codexResetRows.map((credit, index) => {
            const creditKey = codexResetKeys[index];
            return <div className="sidebar-usage-reset-row"
              key={creditKey}>
              <div className="sidebar-usage-reset-summary">
                <b>{t("Reset credit {{index}}", { index: index + 1 })}</b>
                <small>{resetExpiryText(credit.expiresAt) || t("Expiry unavailable")}</small>
              </div>
              {resetConfirming !== creditKey
                ? <button type="button" disabled={resetting}
                  aria-label={t("Use Codex reset credit {{index}}", { index: index + 1 })}
                  onClick={() => setResetConfirming(creditKey)}>{t("Use")}</button>
                : <div className="sidebar-usage-reset-confirmation">
                  <p>{t("This uses one available credit and immediately resets eligible Codex rate-limit windows.")}</p>
                  <div className="sidebar-usage-reset-actions">
                    <button type="button" disabled={resetting}
                      onClick={() => setResetConfirming(null)}>{t("Cancel")}</button>
                    <button type="button"
                      aria-label={t("Confirm using Codex reset credit {{index}}", { index: index + 1 })}
                      disabled={resetting} onClick={() => void consumeCodexReset()}>
                      {resetting ? t("Using…") : t("Confirm")}
                    </button>
                  </div>
                </div>}
            </div>;
          })}
        </div>}
      </section>}
      {resetNotice && <p className="sidebar-usage-reset-notice" role="status">{resetNotice}</p>}
      </div>
      </PaneSurfaceGate>
    </section>
  );
}
