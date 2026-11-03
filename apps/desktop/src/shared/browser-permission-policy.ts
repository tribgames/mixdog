// What the built-in browser does when a site asks for a permission: one
// default per kind (allowed, ask or blocked) and optional per-site exceptions.
// Shared by the main process (which decides and stores) and the settings page.

export type BrowserPermissionSetting = 'allow' | 'ask' | 'block';

/** Every kind a person can set. The names are the decision keys the browser
 *  partition uses (`media:video` is the camera, `media:audio` the microphone,
 *  `clipboard-write` a sanitized clipboard write). */
export const BROWSER_PERMISSION_KINDS = [
  'notifications',
  'geolocation',
  'clipboard-write',
  'clipboard-read',
  'media:video',
  'media:audio',
  'midi',
  'midiSysex',
  'idle-detection',
  'top-level-storage-access',
  'window-management',
  'speaker-selection',
  'fileSystem',
] as const;

export type BrowserPermissionKind = (typeof BROWSER_PERMISSION_KINDS)[number];

/** A site's own setting for one kind, overriding the default. `embedder` is
 *  set only for a frame embedded in another site: a grant never carries from
 *  a site to the same origin embedded elsewhere. */
export interface BrowserPermissionSiteRule {
  origin: string;
  embedder?: string;
  permission: BrowserPermissionKind;
  setting: BrowserPermissionSetting;
}

export interface BrowserPermissionPolicy {
  defaults: Record<BrowserPermissionKind, BrowserPermissionSetting>;
  sites: BrowserPermissionSiteRule[];
}

/** Sites that are quiet by default (notifications, location), a sanitized
 *  clipboard write that only works with a user gesture anyway, and everything
 *  else asked. Reading the clipboard is never allowed unless a person says so. */
export const BROWSER_PERMISSION_DEFAULTS: Readonly<Record<BrowserPermissionKind, BrowserPermissionSetting>> = {
  notifications: 'block',
  geolocation: 'block',
  'clipboard-write': 'allow',
  'clipboard-read': 'ask',
  'media:video': 'ask',
  'media:audio': 'ask',
  midi: 'ask',
  midiSysex: 'ask',
  'idle-detection': 'ask',
  'top-level-storage-access': 'ask',
  'window-management': 'ask',
  'speaker-selection': 'ask',
  fileSystem: 'ask',
};

export const BROWSER_PERMISSION_MAX_SITES = 300;

const SETTINGS: readonly string[] = ['allow', 'ask', 'block'];

export const isBrowserPermissionSetting = (value: unknown): value is BrowserPermissionSetting =>
  typeof value === 'string' && SETTINGS.includes(value);

export const isBrowserPermissionKind = (value: unknown): value is BrowserPermissionKind =>
  typeof value === 'string' && (BROWSER_PERMISSION_KINDS as readonly string[]).includes(value);

export function defaultBrowserPermissionPolicy(): BrowserPermissionPolicy {
  return { defaults: { ...BROWSER_PERMISSION_DEFAULTS }, sites: [] };
}

function webOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The same site rule: one origin (in one embedding site) and one kind. */
export const sameBrowserPermissionSite = (
  a: Pick<BrowserPermissionSiteRule, 'origin' | 'embedder' | 'permission'>,
  b: Pick<BrowserPermissionSiteRule, 'origin' | 'embedder' | 'permission'>
) => a.origin === b.origin && (a.embedder ?? a.origin) === (b.embedder ?? b.origin) && a.permission === b.permission;

/** A stored or received policy as a whole one: unknown kinds, settings and
 *  malformed sites are dropped, a missing default is the built-in one. */
export function normalizeBrowserPermissionPolicy(value: unknown): BrowserPermissionPolicy {
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const policy = defaultBrowserPermissionPolicy();
  const defaults = stored.defaults && typeof stored.defaults === 'object' ? (stored.defaults as object) : {};
  for (const kind of BROWSER_PERMISSION_KINDS) {
    const setting = (defaults as Record<string, unknown>)[kind];
    if (isBrowserPermissionSetting(setting)) policy.defaults[kind] = setting;
  }
  for (const entry of Array.isArray(stored.sites) ? stored.sites : []) {
    // Never truncated: a stored exception is kept however many there are.
    const rule = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const origin = webOrigin(rule.origin);
    const embedder = rule.embedder === undefined ? undefined : webOrigin(rule.embedder);
    if (!origin || (rule.embedder !== undefined && !embedder)) continue;
    if (!isBrowserPermissionKind(rule.permission) || !isBrowserPermissionSetting(rule.setting)) continue;
    const next: BrowserPermissionSiteRule = {
      origin,
      ...(embedder && embedder !== origin ? { embedder } : {}),
      permission: rule.permission,
      setting: rule.setting,
    };
    if (!policy.sites.some((known) => sameBrowserPermissionSite(known, next))) policy.sites.push(next);
  }
  return policy;
}

/** What is stored: only the defaults that differ from the built-in ones, and
 *  the exceptions; undefined when there is nothing to keep. */
export function storableBrowserPermissionPolicy(policy: BrowserPermissionPolicy): Record<string, unknown> | undefined {
  const defaults: Record<string, BrowserPermissionSetting> = {};
  for (const kind of BROWSER_PERMISSION_KINDS) {
    if (policy.defaults[kind] !== BROWSER_PERMISSION_DEFAULTS[kind]) defaults[kind] = policy.defaults[kind];
  }
  const stored: Record<string, unknown> = {};
  if (Object.keys(defaults).length) stored.defaults = defaults;
  if (policy.sites.length) stored.sites = policy.sites;
  return Object.keys(stored).length ? stored : undefined;
}

/** The setting for a kind on a site: the site's own exception, else the default. */
export function browserPermissionSetting(
  policy: BrowserPermissionPolicy,
  permission: BrowserPermissionKind,
  origin: string,
  embedder: string = origin
): BrowserPermissionSetting {
  const rule = policy.sites.find((site) => sameBrowserPermissionSite(site, { origin, embedder, permission }));
  return rule ? rule.setting : policy.defaults[permission];
}

export function withBrowserPermissionDefault(
  policy: BrowserPermissionPolicy,
  permission: BrowserPermissionKind,
  setting: BrowserPermissionSetting
): BrowserPermissionPolicy {
  return { ...policy, defaults: { ...policy.defaults, [permission]: setting } };
}

/** Adds or replaces a site's exception. Null when the rule is new and the
 *  list is full: an existing exception is never dropped to make room. */
export function withBrowserPermissionSite(
  policy: BrowserPermissionPolicy,
  rule: BrowserPermissionSiteRule
): BrowserPermissionPolicy | null {
  const others = policy.sites.filter((site) => !sameBrowserPermissionSite(site, rule));
  if (others.length === policy.sites.length && policy.sites.length >= BROWSER_PERMISSION_MAX_SITES) return null;
  return { ...policy, sites: [...others, rule] };
}

export function withoutBrowserPermissionSite(
  policy: BrowserPermissionPolicy,
  rule: Pick<BrowserPermissionSiteRule, 'origin' | 'embedder' | 'permission'>
): BrowserPermissionPolicy {
  return { ...policy, sites: policy.sites.filter((site) => !sameBrowserPermissionSite(site, rule)) };
}
