// How a `visualize` call reads on its transcript row and its chat card: its
// arguments, the tab an open reported, the live panel tab a card stands for,
// and the title later rows name that tab by. Pure (but for the small
// newest-card registry), so it is testable without a DOM;
// `transcript-visualize-card.tsx` draws the card.
import {
  VISUALIZE_INLINE_KINDS,
  type VisualizeInlineContent,
  type VisualizeInlineKind,
  type VisualizeSessionState,
  type VisualizeTabView,
  versionProducedAt,
  visualizeThumbnail,
} from '../shared/visualize';
import {
  VISUALIZE_OWNER_META_CODE,
  visualizeOwnerMetaSessionId,
} from '../../../../src/runtime/visualize-bridge/tool-meta.mjs';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { type SurfaceOwnerSources, surfaceOwnerChain } from './session-browser-policy';
import { asRecord } from './text-format';
import {
  desktopToolActivitySurface,
  desktopToolDisplayIdentity,
  flattenedToolActivityItems,
  toolItemDone,
} from './transcript-tool-core';

/** An object, or the JSON text of one (models may send either). */
function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function callArgs(item: TranscriptItem): { action: string; input: Record<string, unknown> } {
  // A deferred tool runs through the `call_tool` bridge: its own arguments
  // (`action`, `input`) are the bridge request's `arguments`, and `input`
  // may arrive as JSON text.
  const root = jsonRecord(desktopToolDisplayIdentity(item.name, item.args).args);
  const surface = desktopToolActivitySurface(item.name, item.args);
  return {
    action: String(root?.action ?? surface.args.action ?? ''),
    input: jsonRecord(root?.input) ?? surface.args,
  };
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = asRecord(value)?.content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => String(asRecord(part)?.text ?? '')).join('\n');
}

/** The version an open's result says it made ("… as tab v3 (version 2)…"); 0
 *  when it names none (a host without versions, an older result). */
function visualizeResultVersion(item: TranscriptItem): number {
  const text = `${resultText(item.result)}\n${resultText(item.rawResult)}`;
  return Number(/\bas tab v\d+ \(version (\d+)\)/.exec(text)?.[1] ?? 0);
}

/** The tab id an open's result names ("… as tab v3." / "v3 html label → …"). */
function visualizeResultTabId(item: TranscriptItem): string {
  const text = `${resultText(item.result)}\n${resultText(item.rawResult)}`;
  return (
    /\bas tab (v\d+)\b/.exec(text)?.[1] ??
    /^(v\d+) (?:html|document|pdf|image|audio|video|split) /m.exec(text)?.[1] ??
    ''
  );
}

export interface VisualizeCardCall {
  /** The tool call's id (the card's key). */
  id: string;
  /** Still running: no card yet (visualizeCardsShown). */
  pending: boolean;
  /** The file targets as the agent named them (1-3); empty for inline content. */
  targets: string[];
  /** The direct-renderer content the agent opened (no files): what a closed
   *  card opens again from, with no agent turn. */
  content?: VisualizeInlineContent;
  /** The agent's tab label, when it gave one. */
  label: string;
  /** The panel tab the open reported (`v3`); empty while pending. */
  tabId: string;
  /** The version the open reported making (0 when it named none): what an
   *  earlier card names when this window never saw its turn end. */
  version?: number;
  /** When the call ran (ms), to tell which card of a tab is the newest. */
  at: number;
  /** A turn preview: a file the turn changed that the agent did not open
   *  (turn-preview-model.ts); without a live tab its tile simply opens it. */
  preview?: true;
  /** The thumbnail's top-left mark (turn-preview-model.ts). */
  badge?: 'new';
  /** The conversation whose panel the host put the tab in, as it stamped the
   *  result (its `toolMeta`, never its text): a sub-agent's or room member's
   *  open lands in its owner's panel. Absent for a session's own opens. */
  ownerSessionId?: string;
}

/** The owner the host stamped on a visualize result's `toolMeta`; '' when none. */
function stampedOwner(item: TranscriptItem): string {
  const meta = item.toolMeta;
  return meta?.code === VISUALIZE_OWNER_META_CODE ? visualizeOwnerMetaSessionId(meta.ownerSessionId) : '';
}

/** The conversation whose panel holds a session's visualize tabs, by the
 *  host's rules (main `ownerSessionId`, the approval surface): a sub-agent's
 *  owner, a room member's room log, else the session itself. What the host
 *  stamped on the transcript's own results (`calls`) wins: it is stored with
 *  them, so it outlives the sub-agent's pool row and a reload. Without one
 *  (a turn with previews only), the session's live records: the agent pool
 *  and the room id. Never tool output text. A bot's task session keeps its
 *  tabs itself, so the catalog's task → bot home step is not taken. */
export function visualizeOwnerSessionId(
  sessionId: string,
  pool: SurfaceOwnerSources['pool'],
  calls: readonly VisualizeCardCall[] = []
): string {
  const stamped = calls.find((call) => call.ownerSessionId)?.ownerSessionId;
  return stamped || surfaceOwnerChain(sessionId, { sessions: [], pool }).at(-1) || sessionId;
}

/** When a turn's tool rounds last ran (ms): the time of its preview tiles. */
export function visualizeTurnEndAt(items: readonly TranscriptItem[]): number {
  let at = 0;
  for (const item of flattenedToolActivityItems(items)) {
    at = Math.max(at, Number(item.completedAt ?? item.at ?? item.startedAt) || 0);
  }
  return at;
}

const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `input.content` of an open, when it is well-formed (the tool validated it). */
function inlineContentOf(input: Record<string, unknown>): VisualizeInlineContent | null {
  const content = asRecord(input.content);
  const kind = VISUALIZE_INLINE_KINDS.find((candidate) => candidate === content?.kind);
  if (!content || !kind || typeof content.source !== 'string' || !content.source.trim()) return null;
  const title = typeof content.title === 'string' ? content.title.trim() : '';
  return { kind, source: content.source, ...(title ? { title } : {}) };
}

/** A group's `visualize` opens of files or inline content (web URLs live in
 *  the browser panel and get no card), one card per panel tab (its latest
 *  open), in call order. Failed calls get none. */
export function visualizeCardCalls(items: readonly TranscriptItem[]): VisualizeCardCall[] {
  const calls: VisualizeCardCall[] = [];
  for (const [index, item] of flattenedToolActivityItems(items).entries()) {
    if (item.isError) continue;
    if (desktopToolActivitySurface(item.name, item.args).normalizedName !== 'visualize') continue;
    const { action, input } = callArgs(item);
    if (action !== 'open') continue;
    const content = inlineContentOf(input);
    const raw = Array.isArray(input.targets) ? input.targets : [];
    const targets = content
      ? []
      : raw.filter((target): target is string => typeof target === 'string' && target.trim() !== '');
    if (!content && (!targets.length || targets.some((target) => URL_TARGET.test(target.trim())))) continue;
    const pending = !toolItemDone(item);
    const tabId = pending ? '' : visualizeResultTabId(item);
    if (!pending && !tabId) continue;
    const version = pending ? 0 : visualizeResultVersion(item);
    const owner = pending ? '' : stampedOwner(item);
    const call: VisualizeCardCall = {
      id: String(item.id ?? `visualize:${index}`),
      pending,
      targets,
      ...(content ? { content } : {}),
      label: typeof input.label === 'string' ? input.label : '',
      tabId,
      ...(version ? { version } : {}),
      at: Number(item.startedAt ?? item.at ?? item.completedAt) || 0,
      ...(owner ? { ownerSessionId: owner } : {}),
    };
    const same = tabId ? calls.findIndex((earlier) => earlier.tabId === tabId) : -1;
    if (same >= 0) calls.splice(same, 1);
    calls.push(call);
  }
  return calls;
}

/** The cards to draw now: an open still running is none yet, and while an
 *  agent turn holds the panel (`heldSince`: when it started) its opens wait
 *  for its end, when each appears once on its final version. Cards of earlier
 *  turns stay as they are. */
export function visualizeCardsShown(
  calls: readonly VisualizeCardCall[],
  heldSince: number | null
): VisualizeCardCall[] {
  return calls.filter((call) => !call.pending && (heldSince === null || call.at < heldSince));
}

// The newest card of each tab, per session: one card per tab reads in full
// (the latest open of it); earlier ones in the transcript fold to one line,
// so re-opening a tab across turns does not pile up cards.
const newestCards = new Map<string, Map<string, { id: string; at: number }>>();
const newestListeners = new Set<() => void>();

/** Record `calls` as cards of `sessionId`; a later open of the same tab wins. */
export function noteVisualizeCards(sessionId: string, calls: readonly VisualizeCardCall[]): void {
  let changed = false;
  for (const call of calls) {
    if (!call.tabId) continue;
    let tabs = newestCards.get(sessionId);
    if (!tabs) {
      tabs = new Map();
      newestCards.set(sessionId, tabs);
    }
    const known = tabs.get(call.tabId);
    if (known && (known.id === call.id || known.at > call.at)) continue;
    tabs.set(call.tabId, { id: call.id, at: call.at });
    changed = true;
  }
  if (changed) for (const listener of newestListeners) listener();
}

/** Whether `call` is its tab's newest card (a pending or unseen one is). */
export function visualizeCardNewest(sessionId: string, call: VisualizeCardCall): boolean {
  const known = call.tabId ? newestCards.get(sessionId)?.get(call.tabId) : undefined;
  return !known || known.id === call.id;
}

// The last open of each tab per turn (session + turn key → tab → call): a
// turn whose opens sit in several tool groups (edits between them) leaves
// one card per tab, under the group of its last open.
const TURN_CARDS_LIMIT = 500;
const turnCards = new Map<string, Map<string, { id: string; at: number }>>();
const turnCardsKey = (sessionId: string, turnKey: string) => `${sessionId}\0${turnKey}`;

/** Record `calls` as opens of turn `turnKey`; a later open of a tab wins. */
export function noteVisualizeTurnCards(sessionId: string, turnKey: string, calls: readonly VisualizeCardCall[]): void {
  if (!turnKey) return;
  const key = turnCardsKey(sessionId, turnKey);
  let tabs = turnCards.get(key);
  let changed = false;
  for (const call of calls) {
    if (!call.tabId) continue;
    if (!tabs) {
      tabs = new Map();
      turnCards.set(key, tabs);
      while (turnCards.size > TURN_CARDS_LIMIT) turnCards.delete(turnCards.keys().next().value as string);
    }
    const known = tabs.get(call.tabId);
    if (known && (known.id === call.id || known.at > call.at)) continue;
    tabs.set(call.tabId, { id: call.id, at: call.at });
    changed = true;
  }
  if (changed) for (const listener of newestListeners) listener();
}

/** Whether a later open of the same turn took over `call`'s tab (its card
 *  then shows under that later open only). */
export function visualizeCardSupersededInTurn(sessionId: string, turnKey: string, call: VisualizeCardCall): boolean {
  const known = turnKey && call.tabId ? turnCards.get(turnCardsKey(sessionId, turnKey))?.get(call.tabId) : undefined;
  return Boolean(known && known.id !== call.id && known.at >= call.at);
}

export function subscribeVisualizeCards(listener: () => void): () => void {
  newestListeners.add(listener);
  return () => {
    newestListeners.delete(listener);
  };
}

/** What a card's saved picture is filed under (with the session): the tab, the
 *  version it stands for and what it showed, so an earlier card keeps its own
 *  version's picture and a tab id reused for other files never shows the old one. */
export function visualizeCardThumbnailLine(call: VisualizeCardCall, version: number): string {
  const shown = call.content
    ? `${call.content.kind}:${call.content.title ?? ''}`
    : call.targets.map(normalized).join('|');
  return `visualize|${call.tabId}|v${version}|${shown}`;
}

/** The picture a card of `version` takes from its live tab: the tab's own
 *  when it was taken of that version, else none (never another version's). */
export function visualizeCardLiveThumbnail(tab: VisualizeTabView | null, version: number): string | undefined {
  if (!tab || (tab.thumbnailVersion ?? 0) !== version) return undefined;
  return visualizeThumbnail(tab.thumbnail) || undefined;
}

export type VisualizeCardKind =
  | 'html'
  | 'image'
  | 'markdown'
  | 'mermaid'
  | 'svg'
  | 'chart'
  | 'pdf'
  | 'document'
  | 'audio'
  | 'video'
  | 'split';

const FILE_KINDS: Array<[RegExp, VisualizeCardKind]> = [
  [/\.html?$/i, 'html'],
  [/\.svg$/i, 'image'],
  [/\.(?:png|jpe?g|gif|webp|bmp|avif|ico)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
  [/\.(?:mp3|wav|ogg|m4a|flac|aac)$/i, 'audio'],
  [/\.(?:mp4|webm|mov|mkv|m4v)$/i, 'video'],
];

/** What a card shows, for its placeholder icon: the live tab's panes when it
 *  is open, else what the open named. */
export function visualizeCardKind(call: VisualizeCardCall, tab: VisualizeTabView | null): { kind: VisualizeCardKind } {
  const current = tab?.panes.filter((pane) => pane.version === undefined) ?? [];
  const live = current.length ? current : (tab?.panes ?? []);
  if (live.length > 1) return { kind: 'split' };
  const pane = live[0];
  if (pane) {
    if (pane.kind === 'inline' && pane.inline) return { kind: pane.inline.kind };
    if (pane.kind && pane.kind !== 'inline') return { kind: pane.kind };
  }
  if (call.content) return { kind: call.content.kind };
  if (call.targets.length > 1) return { kind: 'split' };
  const file = call.targets[0] ?? '';
  return { kind: FILE_KINDS.find(([pattern]) => pattern.test(file))?.[1] ?? 'document' };
}

/** A stable tint (0-359) per title, for the placeholder tile. */
export function monogramHue(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

const normalized = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '');
/** Same file: equal, or one is the other's project-relative tail (a remote
 *  client sees cwd-relative targets where the agent may have named absolute ones). */
export function sameTarget(a: string, b: string): boolean {
  const left = normalized(a);
  const right = normalized(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** The files a turn's tool rounds showed as visualize cards (finished opens
 *  only): a changed file among them is shown by its card, not as a diff. */
export function visualizedTargets(items: readonly TranscriptItem[]): string[] {
  return visualizeCardCalls(items).flatMap((call) => (call.pending ? [] : call.targets));
}

/** Whether `tab` shows what `call` opened: the same files, or inline content
 *  of the same kind and title (re-opening it is a new version of that tab). */
function showsCall(tab: VisualizeTabView, call: VisualizeCardCall): boolean {
  const live = livePanes(tab);
  if (call.content) {
    const shown = live[0]?.inline;
    return live.length === 1 && shown?.kind === call.content.kind && shown.title === call.content.title;
  }
  // A preview's one file may be one pane of a side-by-side tab.
  return showsTargets(live, call.targets) || Boolean(call.preview && holdsTarget(live, call.targets));
}

/** The live panes; a tab stepped back to a kept version shows only that
 *  version's panes, and is still the same tab. */
function livePanes(tab: VisualizeTabView): VisualizeTabView['panes'] {
  const current = tab.panes.filter((pane) => pane.version === undefined);
  return current.length ? current : tab.panes;
}

function holdsTarget(live: VisualizeTabView['panes'], targets: readonly string[]): boolean {
  return targets.length === 1 && live.some((pane) => sameTarget(pane.target, targets[0]));
}

/** The live panel tab a card stands for: its id, showing the same files;
 *  once that tab was closed, the tab that shows them now (opening it again
 *  makes a new id). Null when no tab shows them. */
export function visualizeCardTab(state: VisualizeSessionState, call: VisualizeCardCall): VisualizeTabView | null {
  if (!call.tabId) return null;
  const own = state.tabs.find((candidate) => candidate.id === call.tabId);
  if (own && showsCall(own, call)) return own;
  return state.tabs.find((candidate) => candidate.id !== call.tabId && showsCall(candidate, call)) ?? null;
}

/** The kept version a card click shows on `tab` (null = live): an earlier
 *  card's own version on its own tab (the host says when it is gone); live
 *  for the newest card, and on a tab opened again (its versions start over:
 *  the closed tab's were discarded with it). */
export function visualizeCardVersionTarget(
  call: VisualizeCardCall,
  tab: VisualizeTabView,
  version: number,
  newest: boolean
): number | null {
  if (newest || !version || tab.id !== call.tabId || version === tab.versions?.at(-1)?.n) return null;
  return version;
}

function showsTargets(live: VisualizeTabView['panes'], targets: readonly string[]): boolean {
  return live.length === targets.length && live.every((pane, index) => sameTarget(pane.target, targets[index]));
}

/** The live panel tab showing exactly the files `targets` (a preview tile's
 *  tab, whoever opened it), else one showing its one file beside others;
 *  null when none does. */
export function visualizeTabForTargets(
  state: VisualizeSessionState,
  targets: readonly string[]
): VisualizeTabView | null {
  if (!targets.length) return null;
  return (
    state.tabs.find((tab) => showsTargets(livePanes(tab), targets)) ??
    state.tabs.find((tab) => holdsTarget(livePanes(tab), targets)) ??
    null
  );
}

/** A preview tile's name for a file: its own name, or its folder's when the
 *  name says nothing (`design/mockups/login/index.html` is "login"). */
export function previewFileLabel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = parts.at(-1) ?? path;
  return /^index\.[^.]+$/i.test(base) && parts.length > 1 ? (parts.at(-2) ?? base) : base;
}

/** The version the tab shows (the newest when live); 0 without versions. */
export function visualizeCardVersion(tab: VisualizeTabView | null): number {
  return tab?.version ?? tab?.versions?.at(-1)?.n ?? 0;
}

// The version each card's turn ended on (by call id): a card drawn at its
// turn's end records it, so once a later turn opens the tab again the earlier
// card keeps naming its own version.
const cardVersions = new Map<string, number>();

/** Test seam: a renderer reload forgets the in-memory registries (the host's
 *  per-version turn record, carried in the state, is what survives). */
export function resetVisualizeCardMemory(): void {
  cardVersions.clear();
  newestCards.clear();
}

/** `live` while `call` is its tab's newest card (recorded as its own); an
 *  earlier card: the version the host recorded for its turn (the tab's
 *  `versions[].turns`, so a card never drawn live, a reloaded renderer and a
 *  paired device agree), else the one recorded when it was drawn, else the one
 *  its open reported, else 0 (none named). */
export function visualizeCardOwnVersion(
  sessionId: string,
  call: VisualizeCardCall,
  live: number,
  newest: boolean,
  tab: VisualizeTabView | null = null
): number {
  if (newest) {
    // Only once the card is known as its tab's newest (not merely unseen, as
    // every card is on a reloaded renderer's first draw), and only the first
    // version: a later turn's end moves the tab on before this card learns it
    // is no longer the newest.
    const known = newestCards.get(sessionId)?.get(call.tabId)?.id === call.id;
    if (known && live && !cardVersions.has(call.id)) cardVersions.set(call.id, live);
    // A closed tab has no live version: the card keeps the one it showed.
    return live || (cardVersions.get(call.id) ?? call.version ?? 0);
  }
  return versionProducedAt(tab?.versions, call.at) || (cardVersions.get(call.id) ?? call.version ?? 0);
}
// Tab titles as the agent gave them at open ("v1" → "요금제 배치 시안"), per
// session, so later rows (check, capture, close…) name the page, not the id.
const tabTitles = new Map<string, Map<string, string>>();

function openTitle(input: Record<string, unknown>): string {
  const content = asRecord(input.content);
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const contentTitle = typeof content?.title === 'string' ? content.title.trim() : '';
  const targets = Array.isArray(input.targets)
    ? input.targets.filter((target): target is string => typeof target === 'string' && target.trim() !== '')
    : [];
  return label || contentTitle || targets.join(', ');
}

/** Remembers the titles of every tab the group's open calls named. */
export function rememberVisualizeTabTitles(sessionId: string, items: readonly TranscriptItem[]): void {
  for (const item of flattenedToolActivityItems(items)) {
    if (item.isError || desktopToolActivitySurface(item.name, item.args).normalizedName !== 'visualize') continue;
    const { action, input } = callArgs(item);
    if (action !== 'open' || !toolItemDone(item)) continue;
    const tabId = visualizeResultTabId(item);
    const title = openTitle(input);
    if (!tabId || !title) continue;
    let titles = tabTitles.get(sessionId);
    if (!titles) {
      titles = new Map();
      tabTitles.set(sessionId, titles);
    }
    titles.set(tabId, title);
  }
}

/** The remembered title of the tab a visualize call acts on; '' when unknown. */
export function visualizeCallTabTitle(sessionId: string, item: TranscriptItem): string {
  const tab = callArgs(item).input.tab;
  return typeof tab === 'string' ? (tabTitles.get(sessionId)?.get(tab.trim()) ?? '') : '';
}

/** What an inline content is called on the tool row when it has no title. */
export function visualizeInlineKindLabel(kind: VisualizeInlineKind): string {
  switch (kind) {
    case 'mermaid':
      return t('Mermaid diagram');
    case 'chart':
      return t('Chart');
    // Format names, the same in every language.
    case 'svg':
      return 'SVG';
    case 'html':
      return 'HTML';
    default:
      return 'Markdown';
  }
}
