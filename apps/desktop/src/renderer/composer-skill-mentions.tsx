import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { CapabilityIcon } from './CapabilityIcon';
import { selectableComposerSkills, skillAvailable, skillTitle, type ComposerSkill } from './composer-skill';
import { t } from './i18n';
import { subscribeSetupChanges } from './setup-change-refresh';
import { recognisedSlashSpan } from './slash-commands';
import {
  isReservedMentionName,
  mentionedSkillNames,
  skillMentions,
} from '../../../../packages/protocol-client/src/rows/skill-mentions.mjs';

type ComposerSkillCatalog = {
  /** The user's available custom skills: the `$` palette and the + menu. */
  selectable: ComposerSkill[];
  /** Every available skill (on and in scope here), built-ins included: what a
   *  typed `$name` selects. */
  enabled: ReadonlySet<string>;
  /** Skills that exist but are switched off: sent as plain text. */
  disabled: ReadonlySet<string>;
};

const EMPTY_CATALOG: ComposerSkillCatalog = { selectable: [], enabled: new Set(), disabled: new Set() };

export function composerSkillCatalog(value: unknown): ComposerSkillCatalog {
  const status = value as {
    skills?: Array<Parameters<typeof skillAvailable>[0] & { name?: unknown }>;
  } | null;
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  for (const skill of Array.isArray(status?.skills) ? status.skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name) continue;
    if (skillAvailable(skill)) enabled.add(name);
    else if (skill?.state === 'off') disabled.add(name);
  }
  for (const name of enabled) disabled.delete(name);
  return { selectable: selectableComposerSkills(value), enabled, disabled };
}

/** One catalog per answering runtime: a session's own, or a new-task draft's
 *  selected Project (none: the task workspace an unclassified task runs in). */
const catalogKey = (sessionId?: string | null, projectPath?: string | null) =>
  sessionId || `draft:${projectPath || ''}`;

/** A deleted session's own catalog entries. */
export function releaseSessionSkillCatalog(sessionId: string): void {
  const key = catalogKey(sessionId);
  for (const map of [catalogs, startedReads, appliedReads, inflightReads, readFinishedAt]) map.delete(key);
}

async function readSkillsStatus(sessionId?: string | null, projectPath?: string | null): Promise<unknown> {
  if (sessionId) {
    // Scoped to the session's own folder: only what this session can run.
    return (
      await window.mixdogDesktop.invokeCapability({ capability: 'skillsStatus', sessionId, args: [{ scoped: true }] })
    ).value;
  }
  // No Project is the empty project identity: the task workspace the task will run in.
  const [result] = await window.mixdogDesktop.readCapabilities([
    { capability: 'skillsStatus', args: [{ projectPath: projectPath || '' }] },
  ]);
  if (!result?.ok) throw new Error(result && !result.ok ? result.error : t('Skills unavailable.'));
  return result.value;
}

// Last catalog per session, kept for the renderer's lifetime: the + menu and
// the composer paint it at once and refresh behind it (skillsStatus is cached
// daemon-side, so a refresh only moves it when skills changed).
const catalogs = new Map<string, ComposerSkillCatalog>();
const catalogListeners = new Set<() => void>();
const subscribeCatalog = (notify: () => void) => {
  catalogListeners.add(notify);
  return () => {
    catalogListeners.delete(notify);
  };
};

export function cachedSkillCatalog(
  sessionId?: string | null,
  projectPath?: string | null
): ComposerSkillCatalog | undefined {
  return catalogs.get(catalogKey(sessionId, projectPath));
}

// Reads are ordered per catalog: one that started before a skill change must
// not land over the read that started after it.
const startedReads = new Map<string, number>();
const appliedReads = new Map<string, number>();

const SKILL_CATALOG_MIN_AGE_MS = 2000;
const inflightReads = new Map<string, Promise<ComposerSkillCatalog>>();
const readFinishedAt = new Map<string, number>();

export function resetSkillCatalogReadsForTests(): void {
  inflightReads.clear();
  readFinishedAt.clear();
}

export function refreshSkillCatalog(
  sessionId?: string | null,
  projectPath?: string | null,
  options: { force?: boolean } = {}
): Promise<ComposerSkillCatalog> {
  const key = catalogKey(sessionId, projectPath);
  if (!options.force) {
    const inflight = inflightReads.get(key);
    if (inflight) return inflight;
    const cached = catalogs.get(key);
    if (cached && Date.now() - (readFinishedAt.get(key) ?? 0) < SKILL_CATALOG_MIN_AGE_MS) {
      return Promise.resolve(cached);
    }
  }
  const read = (startedReads.get(key) ?? 0) + 1;
  startedReads.set(key, read);
  const promise = (async () => {
    const next = composerSkillCatalog(await readSkillsStatus(sessionId, projectPath));
    if (!startedReads.has(key)) return next;
    readFinishedAt.set(key, Date.now());
    if (read > (appliedReads.get(key) ?? 0)) {
      appliedReads.set(key, read);
      catalogs.set(key, next);
      for (const notify of catalogListeners) notify();
    }
    return catalogs.get(key) ?? next;
  })();
  inflightReads.set(key, promise);
  const clear = () => {
    if (inflightReads.get(key) === promise) inflightReads.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

// Catalogs with a mounted composer, so one change re-reads each of them once
// however many panes show it.
const mountedCatalogs = new Map<string, { sessionId: string; projectPath: string; count: number }>();
let refreshQueued = false;

function refreshMountedCatalogs(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    // A failed read leaves mentions unhighlighted (they still reach the
    // runtime, which resolves them); the + menu surfaces the read error.
    for (const { sessionId, projectPath } of mountedCatalogs.values()) {
      void refreshSkillCatalog(sessionId, projectPath, { force: true }).catch(() => undefined);
    }
  });
}

// Settings mutations that add, remove, enable or disable a skill (directly or
// through the plugin that bundles it).
const SKILL_CATALOG_MUTATIONS = new Set<string>([
  'setDisabledSkills',
  'setSkillEnabled',
  'setExtensionScope',
  'addSkill',
  'saveSkill',
  'removeSkill',
  'reloadSkills',
  'reloadPlugins',
  'addPlugin',
  'updatePlugin',
  'setPluginEnabled',
  'removePlugin',
]);

/** Settings' mutation completion boundary: a resolved skill-changing write
 *  re-reads every mounted composer's catalog. Other capabilities are ignored. */
export function invalidateSkillCatalogForMutation(capability: string): boolean {
  if (!SKILL_CATALOG_MUTATIONS.has(capability)) return false;
  refreshMountedCatalogs();
  return true;
}

export function useSkillCatalog(
  sessionId: string | null | undefined,
  projectPath: string | null | undefined
): ComposerSkillCatalog {
  const session = sessionId || '';
  const project = session ? '' : projectPath || '';
  const key = catalogKey(session, project);
  const catalog = useSyncExternalStore(
    subscribeCatalog,
    () => catalogs.get(key) ?? EMPTY_CATALOG,
    () => EMPTY_CATALOG
  );
  useEffect(() => {
    void refreshSkillCatalog(session, project).catch(() => undefined);
  }, [session, project]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is made from session and project and changes exactly when they do
  useEffect(() => {
    const mounted = mountedCatalogs.get(key);
    if (mounted) mounted.count += 1;
    else mountedCatalogs.set(key, { sessionId: session, projectPath: project, count: 1 });
    const unsubscribeSetup = subscribeSetupChanges(refreshMountedCatalogs);
    window.addEventListener('mixdog:remote-state-gap', refreshMountedCatalogs);
    window.addEventListener('mixdog:remote-reconnected', refreshMountedCatalogs);
    return () => {
      const entry = mountedCatalogs.get(key);
      if (entry && entry.count > 1) entry.count -= 1;
      else mountedCatalogs.delete(key);
      unsubscribeSetup();
      window.removeEventListener('mixdog:remote-state-gap', refreshMountedCatalogs);
      window.removeEventListener('mixdog:remote-reconnected', refreshMountedCatalogs);
    };
  }, [key]);
  return catalog;
}

export type SkillMentionResult = { skill: ComposerSkill; start: number };

export function filterSkillMentions(skills: ComposerSkill[], query: string): SkillMentionResult[] {
  const needle = query.toLowerCase();
  const prefix: SkillMentionResult[] = [];
  const contains: SkillMentionResult[] = [];
  for (const skill of skills) {
    if (isReservedMentionName(skill.name)) continue;
    const start = skill.name.toLowerCase().indexOf(needle);
    if (start === 0) prefix.push({ skill, start });
    else if (start > 0) contains.push({ skill, start });
  }
  return [...prefix, ...contains];
}

type SkillMentionSegment = { text: string; skill?: string };

/** `text` split into plain runs and recognised `$name` tokens. */
export function skillMentionSegments(text: string, isSkill: (name: string) => boolean): SkillMentionSegment[] {
  const segments: SkillMentionSegment[] = [];
  let cursor = 0;
  for (const mention of skillMentions(text, isSkill)) {
    if (mention.start > cursor) segments.push({ text: text.slice(cursor, mention.start) });
    segments.push({ text: text.slice(mention.start, mention.end), skill: mention.name });
    cursor = mention.end;
  }
  if (cursor < text.length || !segments.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

type ComposerHighlightSegment = SkillMentionSegment & { slash?: boolean };

/** `text` split into plain runs, recognised `$name` tokens and a recognised
 *  leading `/command` (colour only; never changes the text). */
export function composerHighlightSegments(
  text: string,
  isSkill: (name: string) => boolean
): ComposerHighlightSegment[] {
  const span = recognisedSlashSpan(text);
  if (!span) return skillMentionSegments(text, isSkill);
  const segments: ComposerHighlightSegment[] = [];
  if (span.start > 0) segments.push({ text: text.slice(0, span.start) });
  segments.push({ text: text.slice(span.start, span.end), slash: true });
  const rest = text.slice(span.end);
  if (rest) segments.push(...skillMentionSegments(rest, isSkill));
  return segments;
}

/** Mentioned skills that exist but are switched off, in first-mention order. */
export function disabledMentionedSkills(text: string, catalog: ComposerSkillCatalog): string[] {
  return mentionedSkillNames(text, (name) => catalog.disabled.has(name));
}

function HighlightSegments({ segments }: { segments: ComposerHighlightSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.skill || segment.slash) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional runs of one string
            <span key={index} className={segment.slash ? 'composer-slash-token' : 'skill-mention-token'}>
              {segment.text}
            </span>
          );
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional runs of one string
        return <React.Fragment key={index}>{segment.text}</React.Fragment>;
      })}
    </>
  );
}

export function SkillMentionText({ text, isSkill }: { text: string; isSkill: (name: string) => boolean }) {
  return <HighlightSegments segments={skillMentionSegments(text, isSkill)} />;
}

// Everything that decides where a glyph lands inside the textarea. The layer
// copies the live computed values, so desktop, mobile and the + menu chip's
// narrower inset all line up without restating the composer's type scale.
const MIRRORED_STYLE = [
  'boxSizing',
  'direction',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontStretch',
  'fontVariant',
  'fontKerning',
  'fontFeatureSettings',
  'fontVariationSettings',
  'fontOpticalSizing',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'textRendering',
  'tabSize',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'lineBreak',
  'hyphens',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
] as const;

interface MirrorStyleCache {
  source: HTMLTextAreaElement;
  borders: number;
  paddingRight: number;
  values: string[];
  lastPaddingRight: number;
  lastLeft: number;
  lastTop: number;
  lastWidth: number;
  lastHeight: number;
  lastScrollTop: number;
}

const mirrorStyleCache = new WeakMap<HTMLDivElement, MirrorStyleCache>();

export function mirrorTextareaBox(source: HTMLTextAreaElement, layer: HTMLDivElement, refreshStyles = false): void {
  // Read all textarea geometry before writing layer.style to avoid forced reflow.
  const offsetWidth = source.offsetWidth;
  const clientWidth = source.clientWidth;
  const offsetLeft = source.offsetLeft;
  const offsetTop = source.offsetTop;
  const offsetHeight = source.offsetHeight;
  const scrollTop = source.scrollTop;

  let cached = mirrorStyleCache.get(layer);
  const needsStyleRefresh = !cached || cached.source !== source || refreshStyles;
  let nextValues: string[] | null = null;
  let borders = cached?.borders ?? 0;
  let basePaddingRight = cached?.paddingRight ?? 0;
  if (needsStyleRefresh) {
    const style = window.getComputedStyle(source);
    nextValues = MIRRORED_STYLE.map((property) => style[property]);
    borders = (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.borderRightWidth) || 0);
    basePaddingRight = Number.parseFloat(style.paddingRight) || 0;
  }

  if (needsStyleRefresh && nextValues) {
    const previousValues = cached?.source === source ? cached.values : null;
    for (let index = 0; index < MIRRORED_STYLE.length; index += 1) {
      const value = nextValues[index];
      if (!previousValues || previousValues[index] !== value) {
        layer.style[MIRRORED_STYLE[index]] = value;
      }
    }
    if (!cached || cached.source !== source) {
      cached = {
        source,
        borders,
        paddingRight: basePaddingRight,
        values: nextValues,
        lastPaddingRight: Number.NaN,
        lastLeft: Number.NaN,
        lastTop: Number.NaN,
        lastWidth: Number.NaN,
        lastHeight: Number.NaN,
        lastScrollTop: Number.NaN,
      };
      mirrorStyleCache.set(layer, cached);
    } else {
      cached.borders = borders;
      cached.paddingRight = basePaddingRight;
      cached.values = nextValues;
    }
  }

  // A vertical scrollbar narrows the textarea's line box; the layer has none,
  // so its right padding absorbs the scrollbar width instead.
  const activeCache = cached!;
  const scrollbar = Math.max(0, offsetWidth - clientWidth - (activeCache.borders || 0));
  const paddingRight = activeCache.paddingRight + scrollbar;
  if (activeCache.lastPaddingRight !== paddingRight) {
    layer.style.paddingRight = `${paddingRight}px`;
    activeCache.lastPaddingRight = paddingRight;
  }
  if (activeCache.lastLeft !== offsetLeft) {
    layer.style.left = `${offsetLeft}px`;
    activeCache.lastLeft = offsetLeft;
  }
  if (activeCache.lastTop !== offsetTop) {
    layer.style.top = `${offsetTop}px`;
    activeCache.lastTop = offsetTop;
  }
  if (activeCache.lastWidth !== offsetWidth) {
    layer.style.width = `${offsetWidth}px`;
    activeCache.lastWidth = offsetWidth;
  }
  if (activeCache.lastHeight !== offsetHeight) {
    layer.style.height = `${offsetHeight}px`;
    activeCache.lastHeight = offsetHeight;
  }
  if (activeCache.lastScrollTop !== scrollTop) {
    layer.scrollTop = scrollTop;
    activeCache.lastScrollTop = scrollTop;
  }
}

export function useComposerSkillHighlight({
  textarea,
  text,
  isSkill,
  disabled,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  text: string;
  isSkill: (name: string) => boolean;
  disabled: boolean;
}): { active: boolean; layer: ReactNode } {
  const [composing, setComposing] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return undefined;
    const start = () => setComposing(true);
    const end = () => setComposing(false);
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    return () => {
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
    };
  }, [textarea]);
  const segments = useMemo(() => composerHighlightSegments(text, isSkill), [text, isSkill]);
  const recognised = segments.some((segment) => segment.skill || segment.slash);
  const active = !disabled && !composing && recognised;
  // Every commit can move the box (autosize, scrollbar), so re-mirror geometry on each;
  // static computed styles stay cached until resize, theme, or font changes.
  useLayoutEffect(() => {
    const element = textarea.current;
    const layer = layerRef.current;
    if (active && element && layer) mirrorTextareaBox(element, layer);
  });
  useEffect(() => {
    const element = textarea.current;
    const layer = layerRef.current;
    if (!active || !element || !layer) return undefined;
    const refresh = () => mirrorTextareaBox(element, layer, true);
    const scroll = () => {
      const top = element.scrollTop;
      layer.scrollTop = top;
      const cached = mirrorStyleCache.get(layer);
      if (cached) cached.lastScrollTop = top;
    };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
    resize?.observe(element);
    const root = element.ownerDocument?.documentElement;
    const themeObserver = root && typeof MutationObserver === 'function' ? new MutationObserver(refresh) : null;
    themeObserver?.observe(root, { attributes: true });
    const fonts = element.ownerDocument?.fonts;
    fonts?.addEventListener?.('loadingdone', refresh);
    element.addEventListener('scroll', scroll);
    return () => {
      resize?.disconnect();
      themeObserver?.disconnect();
      fonts?.removeEventListener?.('loadingdone', refresh);
      element.removeEventListener('scroll', scroll);
    };
  }, [active, textarea]);
  const layer = active ? (
    <div ref={layerRef} className="composer-skill-highlight" aria-hidden="true">
      <HighlightSegments segments={segments} />
      {/* A trailing newline still owns a line in the textarea. */}
      {'\u200b'}
    </div>
  ) : null;
  return { active, layer };
}

/** `appliedSkills` on a transcript user item, read defensively: absent or
 *  malformed means nothing was applied. */
export function appliedSkillsOf(item: unknown): string[] {
  const value = (item as { appliedSkills?: unknown } | null)?.appliedSkills;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === 'string' && name.trim() !== ''))];
}

export function AppliedSkills({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <div className="message-applied-skills">
      <span>{t('Applied skills')}</span>
      {names.map((name) => (
        <span key={name} className="message-applied-skill" title={name}>
          <CapabilityIcon name={name} size={14} />
          {skillTitle(name)}
        </span>
      ))}
    </div>
  );
}
