// The rail's pinned usage readout, split from SidebarUsage so the rail can
// compute it from the cached snapshot in its first render instead of waiting
// for the flyout chunk (the late stack used to shift the rail).
import { t } from './i18n';
import { record } from './record-utils';
import { SUBSCRIPTIONS, type Subscription } from './subscription-providers';
import { expandableAccounts, type UsageAccount, type UsageAccountPool } from './usage-account-pools';
import type { UsageRecord } from './usage-dashboard-store';
import { displayUsagePercent } from './usage-percent';
import { usageResetSchedule as resetSchedule, usageTimestamp as timestamp } from './usage-window-text';

export function usageRows(value: unknown): UsageRecord[] {
  const dashboard = record(value);
  return Array.isArray(dashboard.rows) ? dashboard.rows.map(record) : [];
}

export function usageNumber(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed;
}

/** Subscriptions matched by row id or label whatever the row's group. */
const ROW_MATCHERS: Record<string, (id: string, label: string) => boolean> = {
  'opencode-go-oauth': (id) => id === 'opencode-go-oauth',
  cursor: (id, label) => id === 'cursor-oauth' || label.includes('cursor oauth'),
  antigravity: (id, label) => id === 'antigravity-oauth' || label.includes('antigravity'),
};

/** Subscriptions matched inside the `oauth` group by id/label text. */
const OAUTH_ROW_PATTERNS: Record<string, RegExp> = {
  codex: /openai|codex/,
  claude: /anthropic|claude/,
  grok: /grok|xai/,
};

export function subscriptionRow(dashboard: unknown, subscription: Subscription): UsageRecord {
  return (
    usageRows(dashboard).find((row) => {
      const id = String(row.id || '').toLowerCase();
      const label = String(row.label || '').toLowerCase();
      const matcher = ROW_MATCHERS[subscription.key];
      if (matcher) return matcher(id, label);
      if (String(row.group || '').toLowerCase() !== 'oauth') return false;
      const pattern = OAUTH_ROW_PATTERNS[subscription.key];
      return pattern ? pattern.test(`${id} ${label}`) : id === subscription.provider;
    }) || {}
  );
}

export function quotaWindows(row: UsageRecord): UsageRecord[] {
  return Array.isArray(row.windows) ? row.windows.map(record) : [];
}

export function usedPercent(window: UsageRecord): number | null {
  const value = usageNumber(window.usedPct);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

/** Which quota bars a pinned brand draws on the rail. */
export type UsageRailBars = 'long' | 'short-long';

/** How many slots the rail shows at most when accounts are expanded. */
export type UsageRailSlots = '3' | '5' | 'all';

interface UsagePinWindow {
  label: string;
  percent: number;
  resetAt: number | null;
}

interface UsagePinEntry {
  key: string;
  label: string;
  provider: string;
  /** The figure shown under the bars: the long window's usage in long-only
   *  mode, the highest of all the quota windows in short + long mode. */
  percent: number;
  /** Drawn bars, short window first. */
  bars: UsagePinWindow[];
  /** Every window the tooltip names (short window first when there is one). */
  windows: UsagePinWindow[];
  /** Index in `bars` of the bar holding the figure (the tone follows it). */
  hot: number;
  /** Rail hover text naming the provider and every window. */
  tooltip: string;
  /** Known-connected provider whose quota has not arrived: the row keeps its
   *  final size and the figure fills in place. */
  pending?: boolean;
  /** Expanded accounts: the 1-based account index in the provider's roster
   *  (the badge on the rail icon) and whether it is the account in use. */
  accountIndex?: number;
  accountSelected?: boolean;
}

/** A connected subscription provider and how many bars its row draws in
 *  short + long mode (a provider without a short window draws one). */
export interface UsagePinRosterEntry {
  key: string;
  bars: number;
}

/** The roster the rail remembers from entries that actually drew. */
export function usagePinRoster(entries: readonly UsagePinEntry[]): UsagePinRosterEntry[] {
  return entries.map((entry) => ({ key: entry.key, bars: entry.windows.length > 1 ? 2 : 1 }));
}

/** The connected subscriptions of a provider-setup snapshot (a local read,
 *  unlike the quota fetch). */
export function usagePinRosterFromSetup(setup: unknown): UsagePinRosterEntry[] {
  const value = record(setup);
  const connected = new Set(
    [value.oauth, value.api]
      .flatMap((group) => (Array.isArray(group) ? group.map(record) : []))
      .filter((row) => row.authenticated === true || row.enabled === true)
      .map((row) => String(row.id || ''))
  );
  return SUBSCRIPTIONS.filter((subscription) => connected.has(subscription.provider)).map((subscription) => ({
    key: subscription.key,
    bars: 1,
  }));
}

/** Real entries, plus a neutral same-size row for every roster provider whose
 *  quota is not known yet, in subscription order. */
export function usagePinEntriesWithRoster(
  real: readonly UsagePinEntry[],
  roster: readonly UsagePinRosterEntry[],
  mode: UsageRailBars
): UsagePinEntry[] {
  return SUBSCRIPTIONS.flatMap((subscription): UsagePinEntry[] => {
    const entry = real.find((candidate) => candidate.key === subscription.key);
    if (entry) return [entry];
    const known = roster.find((candidate) => candidate.key === subscription.key);
    if (!known) return [];
    const count = mode === 'short-long' && known.bars > 1 ? 2 : 1;
    const bars = Array.from({ length: count }, (_, index) => ({
      label: String(index),
      percent: 0,
      resetAt: null,
    }));
    return [
      {
        key: subscription.key,
        label: subscription.label,
        provider: subscription.provider,
        percent: 0,
        bars,
        windows: bars,
        hot: 0,
        tooltip: subscription.label,
        pending: true,
      },
    ];
  });
}

const PIN_WINDOW_PRIORITY = [
  /^(?:M|MO|MON|MONTH|MONTHLY)$/i,
  /^(?:7D|W|WK|WEEK|WEEKLY)$/i,
  /^(?:\d+H|\d+D|D|DAY|DAILY)$/i,
];

/** Window length in hours from its label; null for non-duration labels. */
function windowHours(label: string): number | null {
  const text = label.trim();
  const hours = /^(\d+)H$/i.exec(text);
  if (hours) return Number(hours[1]);
  const days = /^(\d+)D$/i.exec(text);
  if (days) return Number(days[1]) * 24;
  if (/^(?:D|DAY|DAILY)$/i.test(text)) return 24;
  if (/^(?:W|WK|WEEK|WEEKLY)$/i.test(text)) return 168;
  if (/^(?:M|MO|MON|MONTH|MONTHLY)$/i.test(text)) return 720;
  return null;
}

function pinWindows(
  windows: UsageRecord[],
  provider: string
): { pair: UsagePinWindow[]; long: UsagePinWindow; all: UsagePinWindow[]; peak: number } | null {
  const candidates = windows.flatMap((window): UsagePinWindow[] => {
    const percent = usedPercent(window);
    return percent === null
      ? []
      : [{ label: String(window.label || '').trim(), percent, resetAt: timestamp(window.resetAt) }];
  });
  if (!candidates.length) return null;
  let long: UsagePinWindow | undefined;
  const preferredLabel = provider === 'cursor-oauth' ? 'Basic' : '';
  if (preferredLabel) {
    long = candidates.find((candidate) => candidate.label.toLowerCase() === preferredLabel.toLowerCase());
  }
  for (const pattern of PIN_WINDOW_PRIORITY) {
    if (long) break;
    long = candidates.find((candidate) => pattern.test(candidate.label));
  }
  long ||= candidates[candidates.length - 1];
  const longHours = windowHours(long.label);
  let short: UsagePinWindow | null = null;
  let shortHours = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const hours = windowHours(candidate.label);
    if (candidate === long || hours === null || (longHours !== null && hours >= longHours)) continue;
    if (hours < shortHours) {
      short = candidate;
      shortHours = hours;
    }
  }
  // The drawn pair, thick bar first. A second window without a duration
  // (Cursor API) still draws, after the long one.
  let pair = short ? [short, long] : [long];
  if (!short) {
    const other = candidates.find((candidate) => candidate !== long && windowHours(candidate.label) === null);
    if (other) pair = [long, other];
  }
  return { pair, long, all: candidates, peak: Math.max(...candidates.map((candidate) => candidate.percent)) };
}

/** The windows the hover text names: the drawn pair, then every other one. */
function pinTooltipWindows(picked: NonNullable<ReturnType<typeof pinWindows>>): UsagePinWindow[] {
  return [...picked.pair, ...picked.all.filter((window) => !picked.pair.includes(window))];
}

/** The figure under a brand's bars: the long window alone in long-only mode,
 *  the highest window in short + long mode. */
function pinFigure(picked: NonNullable<ReturnType<typeof pinWindows>>, mode: UsageRailBars): number {
  return mode === 'short-long' ? picked.peak : picked.long.percent;
}

/** Index of the drawn bar holding the figure (the last one on a tie); when the
 *  highest window is not drawn, the highest drawn bar. */
function hotBar(bars: readonly UsagePinWindow[], peak: number): number {
  let hot = 0;
  let holder = -1;
  bars.forEach((bar, index) => {
    if (bar.percent >= bars[hot].percent) hot = index;
    if (bar.percent === peak) holder = index;
  });
  return holder >= 0 ? holder : hot;
}

/** Rail pin mode: one entry per brand that has quota data —
 *  its icon plus the final quota window's usage, picked by longest period:
 *  monthly (M) → weekly (7D/W) → daily/hourly. Unknown windows fall back to
 *  the provider's final entry. In `short-long` mode the shortest-duration
 *  window joins as a second bar (none for a provider without one) and the
 *  figure/tone follow the highest window. Long-only mode shows the long
 *  window's own figure: the user chose that period. */
export function usagePinEntries(dashboard: unknown, mode: UsageRailBars = 'long'): UsagePinEntry[] {
  return SUBSCRIPTIONS.flatMap((subscription) => {
    const picked = pinWindows(quotaWindows(subscriptionRow(dashboard, subscription)), subscription.provider);
    if (!picked) return [];
    const windows = picked.pair;
    const bars = mode === 'short-long' ? windows : [picked.long];
    const percent = pinFigure(picked, mode);
    return [
      {
        key: subscription.key,
        label: subscription.label,
        provider: subscription.provider,
        percent,
        bars,
        windows,
        hot: hotBar(bars, percent),
        tooltip: usagePinTooltip(subscription.label, pinTooltipWindows(picked)),
      },
    ];
  });
}

/** The name an account shows under: its registered label, else its email, else its id. */
export function usageAccountName(account: Pick<UsageAccount, 'id' | 'label' | 'email'>): string {
  return account.label.trim() || account.email.trim() || account.id;
}

/** "Expand all accounts": every account of a multi-account provider replaces
 *  the provider's single entry, in roster order, each with its own windows. */
export function usagePinAccountEntries(
  entries: readonly UsagePinEntry[],
  pools: ReadonlyMap<string, UsageAccountPool>,
  mode: UsageRailBars
): UsagePinEntry[] {
  return entries.flatMap((entry) => {
    const accounts = entry.pending ? [] : expandableAccounts(pools.get(entry.provider));
    if (!accounts.length) return [entry];
    const selectedId = pools.get(entry.provider)?.selectedId;
    return accounts.map((account, index): UsagePinEntry => {
      const picked = pinWindows(account.windows, entry.provider);
      const windows = picked ? picked.pair : [];
      let bars: typeof windows;
      if (!picked) bars = [{ label: '0', percent: 0, resetAt: null }];
      else if (mode === 'short-long') bars = windows;
      else bars = [picked.long];
      const title = `${entry.label} · ${index + 1} ${usageAccountName(account)}`;
      const percent = picked ? pinFigure(picked, mode) : 0;
      return {
        key: `${entry.key}:${account.id}`,
        label: entry.label,
        provider: entry.provider,
        percent,
        bars,
        windows,
        hot: picked ? hotBar(bars, percent) : 0,
        tooltip: picked ? usagePinTooltip(title, pinTooltipWindows(picked)) : title,
        pending: picked ? undefined : true,
        accountIndex: index + 1,
        accountSelected: account.id === selectedId,
      };
    });
  });
}

function pinWindowName(label: string): string {
  const hours = windowHours(label);
  if (hours === 168) return t('weekly');
  if (hours === 720) return t('monthly');
  if (hours === 24) return t('daily');
  const count = /^(\d+)([HD])$/i.exec(label.trim());
  if (count) return t(count[2].toUpperCase() === 'H' ? '{{n}}-hour' : '{{n}}-day', { n: count[1] });
  return label;
}

/** Rail hover text: the provider plus every window's usage and reset time. */
function usagePinTooltip(label: string, windows: UsagePinWindow[]): string {
  const parts = windows.map((window) => {
    const schedule = resetSchedule(window.resetAt);
    const reset = schedule.state === 'in' ? ` (${t('resets in {{time}}', { time: schedule.time })})` : '';
    return `${pinWindowName(window.label)} ${displayUsagePercent(window.percent)}%${reset}`;
  });
  return [label, ...parts].join(' · ');
}
