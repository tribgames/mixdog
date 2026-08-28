import { isIP } from 'node:net';

export const MAX_BACKGROUND_TABS = 8;
export const BACKGROUND_PAGE_IDLE_MS = 30 * 60_000;
const MAX_BACKGROUND_TAB_NAME_CHARS = 64;
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 160;
const MAX_SNAPSHOT_ELEMENTS = 500;
const DEFAULT_SNAPSHOT_TEXT_CHARS = 2_400;
const MAX_SNAPSHOT_TEXT_CHARS = 12_000;

export interface BrowserUrlPolicy {
  allowPrivateNetwork?: boolean;
  allowedDomains?: string[];
}

export interface BrowserSnapshotExpressionOptions {
  snapshotId: string;
  maxElements?: number;
  textChars?: number;
  query?: string;
  viewportOnly?: boolean;
}

export function normalizeBackgroundTabName(raw: string, options: { required?: boolean } = {}): string {
  const name = String(raw || '').trim();
  if (!name) {
    if (options.required) throw new Error('a background tab name is required');
    return 'bg';
  }
  if (name.length > MAX_BACKGROUND_TAB_NAME_CHARS) {
    throw new Error(`background tab names may not exceed ${MAX_BACKGROUND_TAB_NAME_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('background tab names may not contain control characters');
  }
  if (/^[vp]\d+$/i.test(name)) {
    throw new Error('background tab names may not use the reserved p1/p2… or v1/v2… form');
  }
  return name;
}

export function assertBackgroundTabCapacity(openTabs: number): void {
  if (openTabs >= MAX_BACKGROUND_TABS) {
    throw new Error(
      `at most ${MAX_BACKGROUND_TABS} background tabs may be open; call list_tabs and close_tab before opening another`,
    );
  }
}

export function backgroundPageIdle(
  lastUsedAt: number,
  now = Date.now(),
  idleMs = BACKGROUND_PAGE_IDLE_MS,
): boolean {
  return Number.isFinite(lastUsedAt)
    && Number.isFinite(now)
    && Number.isFinite(idleMs)
    && idleMs >= 0
    && now - lastUsedAt >= idleMs;
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){0,3}$/.test(host);
}

function parseIpv4(hostname: string): number[] | null {
  const parts = normalizedHostname(hostname).split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return numbers;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = parseIpv4(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function mappedIpv4(hostname: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalizedHostname(hostname));
  return match?.[1] || null;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const host = normalizedHostname(address);
  const mapped = mappedIpv4(host);
  if (mapped) return isPrivateIpv4(mapped);
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) !== 6) return false;
  return host === '::'
    || host === '::1'
    || /^(?:fc|fd)[0-9a-f]{2}:/i.test(host)
    || /^fe[89ab][0-9a-f]:/i.test(host);
}

function isCloudMetadataHost(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === '169.254.169.254'
    || host === '169.254.170.2'
    || host === '100.100.100.200'
    || host === 'metadata.google.internal'
    || host === 'metadata.goog'
    || host === 'fd00:ec2::254';
}

function decodedUrlCandidates(raw: string): string[] {
  const values = [String(raw || '')];
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(values.at(-1)!.replace(/\+/g, '%20'));
      if (decoded === values.at(-1)) break;
      values.push(decoded);
    } catch {
      break;
    }
  }
  return values;
}

export function browserUrlContainsSecret(raw: string): boolean {
  const candidates = decodedUrlCandidates(raw);
  const tokenPatterns = [
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
    /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  ];
  if (candidates.some((candidate) => tokenPatterns.some((pattern) => pattern.test(candidate)))) {
    return true;
  }
  try {
    const parsed = new URL(raw);
    for (const [key, value] of parsed.searchParams) {
      if (value && /^(?:access[_-]?token|api[_-]?key|apikey|authorization|password|passwd|secret|token)$/i.test(key)) {
        return true;
      }
    }
  } catch {
    // The caller owns URL syntax validation; raw token detection above still applies.
  }
  return false;
}

function allowedByDomainPolicy(hostname: string, allowedDomains: string[]): boolean {
  const host = normalizedHostname(hostname);
  return allowedDomains.some((raw) => {
    const domain = normalizedHostname(raw.replace(/^\*\./, ''));
    if (!domain) return false;
    return host === domain || (raw.trim().startsWith('*.') && host.endsWith(`.${domain}`));
  });
}

/** Browser navigation stays on the web and cannot silently cross into a
 * private network. Loopback remains available for local web-app development. */
function normalizeBrowserUrl(
  raw: string,
  policy: BrowserUrlPolicy,
  rejectSecrets: boolean,
): string {
  const text = String(raw || '').trim();
  if (!text) throw new Error('navigate requires url');
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`invalid url: ${redactBrowserText(text)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`only http(s) navigation is allowed (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not allowed');
  }
  const host = normalizedHostname(parsed.hostname);
  if (rejectSecrets && !isLoopbackHostname(host) && browserUrlContainsSecret(parsed.href)) {
    throw new Error('navigation URLs may not contain credential-like query values or secret tokens');
  }
  if (isCloudMetadataHost(host)) {
    throw new Error('navigation to cloud metadata endpoints is blocked');
  }
  if (!policy.allowPrivateNetwork
    && !isLoopbackHostname(host)
    && isPrivateNetworkAddress(host)) {
    throw new Error(`navigation to private or internal address ${host} is blocked`);
  }
  const allowedDomains = policy.allowedDomains?.map((domain) => domain.trim()).filter(Boolean) || [];
  if (allowedDomains.length && !allowedByDomainPolicy(host, allowedDomains)) {
    throw new Error(`navigation to ${host} is blocked by the Browser Use domain policy`);
  }
  return parsed.href;
}

export function normalizeAgentUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return normalizeBrowserUrl(raw, policy, true);
}

/** Page-generated requests may contain OAuth or tracking tokens that are
 * required for the site to work. They retain scheme, credential, domain,
 * metadata, and private-network checks; only agent-input secret rejection is
 * skipped. */
export function normalizePageUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return normalizeBrowserUrl(raw, policy, false);
}

export function assertResolvedAddressAllowed(
  address: string,
  hostname: string,
  policy: BrowserUrlPolicy = {},
): void {
  if (policy.allowPrivateNetwork || isLoopbackHostname(hostname)) return;
  if (isCloudMetadataHost(address) || isPrivateNetworkAddress(address)) {
    throw new Error(`navigation to ${hostname} resolved to blocked private or internal address ${address}`);
  }
}

export function redactBrowserText(value: unknown): string {
  let text = String(value ?? '');
  text = text.replace(
    /\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    (_match, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
  text = text.replace(
    /([?&](?:access[_-]?token|api[_-]?key|apikey|auth|authorization|key|password|passwd|secret|token)=)[^&#\s]*/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[REDACTED_AUTH]');
  text = text.replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]');
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_JWT]',
  );
  text = text.replace(/^((?:set-)?cookie\s*:\s*).+$/gim, '$1[REDACTED]');
  return text;
}

export function redactBrowserUrl(value: unknown): string {
  const raw = String(value ?? '');
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|key|password|passwd|secret|token)/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return redactBrowserText(parsed.href);
  } catch {
    return redactBrowserText(raw);
  }
}

/** Page-context semantic snapshot. It follows open shadow roots and same-origin
 * frames, prioritizes viewport elements before applying the cap, and binds each
 * ref to one snapshot generation so an old ref can never alias a new element. */
export function browserSnapshotExpression(options: BrowserSnapshotExpressionOptions): string {
  const config = {
    snapshotId: String(options.snapshotId),
    maxElements: Math.min(
      MAX_SNAPSHOT_ELEMENTS,
      Math.max(1, Math.trunc(options.maxElements || DEFAULT_SNAPSHOT_MAX_ELEMENTS)),
    ),
    textChars: Math.min(
      MAX_SNAPSHOT_TEXT_CHARS,
      Math.max(200, Math.trunc(options.textChars || DEFAULT_SNAPSHOT_TEXT_CHARS)),
    ),
    query: String(options.query || '').trim().toLowerCase(),
    viewportOnly: options.viewportOnly === true,
  };
  return `(() => {
    const config = ${JSON.stringify(config)};
    const refs = new Map();
    window.__mixdogAgentSnapshot = { id: config.snapshotId, refs };
    const compact = (value, max) => String(value == null ? '' : value)
      .replace(/\\s+/g, ' ').trim().slice(0, max);
    const interactiveRoles = new Set([
      'button', 'link', 'tab', 'checkbox', 'radio', 'combobox', 'menuitem',
      'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox', 'slider',
      'spinbutton', 'switch', 'textbox', 'treeitem',
    ]);
    const candidates = [];
    const headings = [];
    const pageTexts = [];
    const seenDocuments = new Set();
    const stack = [{ el: document.documentElement, frames: [] }];
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let scanned = 0;
    let crossOriginFrames = 0;
    const MAX_SCAN = 12000;

    const inferRole = (el, tag) => {
      const explicit = compact(el.getAttribute('role'), 40).toLowerCase();
      if (explicit) return explicit;
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = compact(el.getAttribute('type') || 'text', 30).toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return tag;
    };
    const accessibleName = (el, tag) => {
      const doc = el.ownerDocument;
      const labelledBy = compact(el.getAttribute('aria-labelledby'), 200);
      if (labelledBy) {
        const named = labelledBy.split(/\\s+/)
          .map((id) => doc.getElementById(id)?.textContent || '')
          .join(' ');
        if (compact(named, 120)) return compact(named, 120);
      }
      const labels = el.labels && el.labels.length
        ? Array.from(el.labels).map((label) => label.textContent || '').join(' ')
        : '';
      return compact(
        el.getAttribute('aria-label')
          || labels
          || (tag === 'input' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase()) ? el.value : '')
          || el.getAttribute('alt')
          || el.getAttribute('placeholder')
          || el.getAttribute('title')
          || el.innerText
          || el.textContent
          || '',
        120,
      );
    };
    const globalRect = (el, frames) => {
      const rect = el.getBoundingClientRect();
      let left = rect.left;
      let top = rect.top;
      for (const frame of frames) {
        const frameRect = frame.getBoundingClientRect();
        left += frameRect.left;
        top += frameRect.top;
      }
      return { left, top, right: left + rect.width, bottom: top + rect.height, width: rect.width, height: rect.height };
    };
    const stateList = (el) => {
      const states = [];
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
      if (el.checked === true || el.getAttribute('aria-checked') === 'true') states.push('checked');
      if (el.checked === false || el.getAttribute('aria-checked') === 'false') states.push('unchecked');
      if (el.selected === true || el.getAttribute('aria-selected') === 'true') states.push('selected');
      if (el.getAttribute('aria-expanded')) states.push('expanded=' + el.getAttribute('aria-expanded'));
      if (el.getAttribute('aria-pressed')) states.push('pressed=' + el.getAttribute('aria-pressed'));
      if (el.required || el.getAttribute('aria-required') === 'true') states.push('required');
      if (el.readOnly || el.getAttribute('aria-readonly') === 'true') states.push('readonly');
      if (el.ownerDocument.activeElement === el) states.push('focused');
      return states;
    };

    while (stack.length && scanned < MAX_SCAN) {
      const item = stack.pop();
      const el = item && item.el;
      if (!el || el.nodeType !== 1) continue;
      scanned += 1;
      const frames = item.frames;
      const doc = el.ownerDocument;
      if (!seenDocuments.has(doc)) {
        seenDocuments.add(doc);
        const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
        if (bodyText) pageTexts.push(bodyText);
      }
      const tag = (el.tagName || '').toLowerCase();
      let style;
      try {
        style = doc.defaultView.getComputedStyle(el);
      } catch {
        style = null;
      }
      const rect = globalRect(el, frames);
      const rendered = rect.width >= 1 && rect.height >= 1
        && style?.display !== 'none' && style?.visibility !== 'hidden'
        && (!style?.opacity || Number(style.opacity) !== 0);
      const inViewport = rendered
        && rect.right > 0 && rect.bottom > 0
        && rect.left < viewportWidth && rect.top < viewportHeight;
      const role = inferRole(el, tag);
      const name = accessibleName(el, tag);
      if (/^h[1-6]$/.test(tag) && name && headings.length < 30) {
        headings.push(tag + ' ' + name);
      }
      let hasListeners = false;
      if (scanned <= 2000 && typeof getEventListeners === 'function') {
        try {
          const listeners = getEventListeners(el);
          hasListeners = Boolean(listeners.click || listeners.mousedown || listeners.pointerdown);
        } catch {}
      }
      const tabindex = el.hasAttribute('tabindex') ? Number(el.getAttribute('tabindex')) : Number.NaN;
      const standardInteractive = (
        (tag === 'a' && el.hasAttribute('href'))
        || ['button', 'input', 'select', 'textarea', 'summary'].includes(tag)
        || interactiveRoles.has(role)
        || el.isContentEditable
        || (Number.isFinite(tabindex) && tabindex >= 0)
        || el.hasAttribute('onclick')
        || typeof el.onclick === 'function'
        || hasListeners
        || (style?.cursor === 'pointer' && Boolean(name))
      );
      if (rendered && standardInteractive) {
        const type = tag === 'input' ? compact(el.getAttribute('type') || 'text', 30).toLowerCase() : '';
        const sensitive = type === 'password';
        const value = sensitive ? '' : compact(el.value ?? '', 100);
        const href = tag === 'a' ? compact(el.href || el.getAttribute('href') || '', 200) : '';
        const semanticHref = (() => {
          try {
            const parsed = new URL(href, location.href);
            return (parsed.hostname + decodeURIComponent(parsed.pathname)).toLowerCase();
          } catch {
            return href.split(/[?#]/, 1)[0].toLowerCase();
          }
        })();
        const rolePriority = ({
          link: 40, button: 35, menuitem: 30, menuitemcheckbox: 30,
          menuitemradio: 30, tab: 25, option: 20, checkbox: 15, radio: 15,
          switch: 15, combobox: 10, listbox: 10, searchbox: 10, textbox: 10,
        })[role] || 0;
        const matches = [
          ['name', name.toLowerCase(), 400],
          ['value', value.toLowerCase(), 300],
          ['role', role.toLowerCase(), 200],
          ['href', semanticHref, role === 'link' ? 330 : 100],
        ];
        const match = config.query
          ? matches
            .filter(([, candidate]) => candidate.includes(config.query))
            .map(([field, candidate, base]) => [
              field,
              candidate,
              base + rolePriority
                + (candidate === config.query ? 20 : candidate.startsWith(config.query) ? 10 : 0),
            ])
            .sort((left, right) => right[2] - left[2])[0]
          : null;
        if ((!config.query || match) && (!config.viewportOnly || inViewport)) {
          candidates.push({
            order: scanned,
            matchScore: match ? match[2] : 0,
            el,
            frames,
            entry: {
              role,
              name,
              tag,
              href,
              value,
              sensitive,
              states: stateList(el),
              inViewport,
              ...(match ? { matchField: match[0] } : {}),
            },
          });
        }
      }

      if (tag === 'iframe' || tag === 'frame') {
        try {
          const childDocument = el.contentDocument;
          if (childDocument?.documentElement) {
            stack.push({ el: childDocument.documentElement, frames: [...frames, el] });
          } else {
            crossOriginFrames += 1;
          }
        } catch {
          crossOriginFrames += 1;
        }
      }
      const children = Array.from(el.children || []);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ el: children[index], frames });
      }
      if (el.shadowRoot) {
        const shadowChildren = Array.from(el.shadowRoot.children || []);
        for (let index = shadowChildren.length - 1; index >= 0; index -= 1) {
          stack.push({ el: shadowChildren[index], frames });
        }
      }
    }

    candidates.sort((left, right) => right.matchScore - left.matchScore
      || Number(right.entry.inViewport) - Number(left.entry.inViewport)
      || left.order - right.order);
    const totalElements = candidates.length;
    const selected = candidates.slice(0, config.maxElements);
    const elements = selected.map((candidate, index) => {
      const ref = config.snapshotId + '-e' + (index + 1);
      refs.set(ref, { element: candidate.el, frames: candidate.frames });
      return { ref, ...candidate.entry };
    });
    const text = compact(pageTexts.join('\\n'), config.textChars);
    return {
      snapshotId: config.snapshotId,
      url: String(location.href),
      title: compact(document.title, 150),
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(document.documentElement.scrollHeight),
      viewportWidth: Math.round(viewportWidth),
      viewportHeight: Math.round(viewportHeight),
      elements,
      totalElements,
      scanned,
      scanCapped: scanned >= MAX_SCAN,
      crossOriginFrames,
      headings,
      text,
      query: config.query,
    };
  })()`;
}

export function browserRefPointExpression(ref: string): string {
  return `(async () => {
    const snapshot = window.__mixdogAgentSnapshot;
    const record = snapshot?.refs?.get(${JSON.stringify(ref)});
    const el = record?.element || record;
    const frames = Array.isArray(record?.frames) ? record.frames : [];
    if (!snapshot || !el || !el.isConnected) return { error: 'stale' };
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return { error: 'disabled' };
    const ownerWindow = el.ownerDocument?.defaultView || window;
    const style = ownerWindow.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden'
      || style.pointerEvents === 'none' || (style.opacity !== '' && Number(style.opacity) === 0)) {
      return { error: 'not-actionable' };
    }
    const nextVisualTick = () => new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, 100);
      requestAnimationFrame(finish);
    });
    el.scrollIntoView({ block: 'center', inline: 'center' });
    for (const frame of frames) frame.scrollIntoView({ block: 'center', inline: 'center' });
    await nextVisualTick();
    await nextVisualTick();
    const first = el.getBoundingClientRect();
    await nextVisualTick();
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { error: 'not-visible' };
    if (Math.abs(first.left - rect.left) > 2 || Math.abs(first.top - rect.top) > 2
      || Math.abs(first.width - rect.width) > 2 || Math.abs(first.height - rect.height) > 2) {
      return { error: 'moving' };
    }
    let offsetX = 0;
    let offsetY = 0;
    for (const frame of frames) {
      const frameRect = frame.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
    }
    const points = [
      [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
    ];
    const controlSelector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"]';
    const controlFor = (value) => value?.matches?.(controlSelector)
      ? value
      : value?.closest?.(controlSelector);
    const sameDestination = (left, right) => {
      if (!left || !right || left === right
        || left.matches?.('a[href]') !== true || right.matches?.('a[href]') !== true) return false;
      try {
        return new URL(left.href, location.href).href === new URL(right.href, location.href).href;
      } catch {
        return false;
      }
    };
    const deepHit = (globalX, globalY) => {
      let doc = document;
      let localX = globalX;
      let localY = globalY;
      for (const frame of frames) {
        const frameRect = frame.getBoundingClientRect();
        const frameHit = doc.elementFromPoint(localX, localY);
        if (frameHit !== frame && !frame.contains(frameHit) && !frameHit?.contains?.(frame)) return frameHit;
        localX -= frameRect.left;
        localY -= frameRect.top;
        doc = frame.contentDocument;
        if (!doc) return frameHit;
      }
      let hit = doc.elementFromPoint(localX, localY);
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint?.(localX, localY);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      return hit;
    };
    let covering = null;
    for (const [rx, ry] of points) {
      const x = Math.round(Math.min(Math.max(0, window.innerWidth - 1), Math.max(0, offsetX + rect.left + rect.width * rx)));
      const y = Math.round(Math.min(Math.max(0, window.innerHeight - 1), Math.max(0, offsetY + rect.top + rect.height * ry)));
      const hit = deepHit(x, y);
      const targetControl = controlFor(el);
      const hitControl = controlFor(hit);
      const related = hit && (
        hit === el
        || (el.contains(hit) && (!hitControl || hitControl === targetControl))
        || (targetControl && hitControl === targetControl)
        || sameDestination(targetControl, hitControl)
      );
      if (related) return { x, y };
      covering = hit || covering;
    }
    if (covering) {
      const label = covering
        ? ((covering.tagName || 'element').toLowerCase() + ' "'
          + String(covering.getAttribute?.('aria-label') || covering.textContent || '')
            .replace(/\\s+/g, ' ').trim().slice(0, 60) + '"')
        : 'nothing';
      return { error: 'covered', covering: label };
    }
    return { error: 'not-visible' };
  })()`;
}
