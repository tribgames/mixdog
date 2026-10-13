// The chat card of a `visualize` open: which calls get one, and which live
// panel tab (if any) each card stands for. Pure, so it is testable without a
// DOM; `transcript-visualize-card.tsx` draws it.
import {
  VISUALIZE_INLINE_KINDS,
  type VisualizeInlineContent,
  type VisualizeInlineKind,
  type VisualizePaneKind,
  type VisualizeSessionState,
  type VisualizeTabView,
} from '../shared/visualize';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';
import { desktopToolActivitySurface, flattenedToolActivityItems, toolItemDone } from './transcript-tool-core';

export interface VisualizeCardCall {
  /** The tool call's id (the card's key). */
  id: string;
  /** Still running: the card shimmers "Opening…". */
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
}

const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;

export function callArgs(item: TranscriptItem): { action: string; input: Record<string, unknown> } {
  let root = asRecord(item.args);
  if (!root && typeof item.args === 'string') {
    try {
      root = asRecord(JSON.parse(item.args));
    } catch {
      root = null;
    }
  }
  const surface = desktopToolActivitySurface(item.name, item.args);
  return {
    action: String(root?.action ?? surface.args.action ?? ''),
    input: asRecord(root?.input) ?? surface.args,
  };
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = asRecord(value)?.content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => String(asRecord(part)?.text ?? '')).join('\n');
}

/** The tab id an open's result names ("… as tab v3." / "v3 html label → …"). */
export function visualizeResultTabId(item: TranscriptItem): string {
  const text = `${resultText(item.result)}\n${resultText(item.rawResult)}`;
  return (
    /\bas tab (v\d+)\b/.exec(text)?.[1] ??
    /^(v\d+) (?:html|document|pdf|image|audio|video|split) /m.exec(text)?.[1] ??
    ''
  );
}

/** `input.content` of an open, when it is well-formed (the tool validated it). */
function inlineContentOf(input: Record<string, unknown>): VisualizeInlineContent | null {
  const content = asRecord(input.content);
  const kind = VISUALIZE_INLINE_KINDS.find((candidate) => candidate === content?.kind);
  if (!content || !kind || typeof content.source !== 'string' || !content.source.trim()) return null;
  const title = typeof content.title === 'string' ? content.title.trim() : '';
  return { kind, source: content.source, ...(title ? { title } : {}) };
}

/** A group's `visualize` opens of files (web URLs live in the browser panel
 *  and get no card), one card per panel tab (its latest open), in call order.
 *  Failed calls get none. */
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
    const call = {
      id: String(item.id ?? `visualize:${index}`),
      pending,
      targets,
      ...(content ? { content } : {}),
      label: typeof input.label === 'string' ? input.label : '',
      tabId,
    };
    const same = tabId ? calls.findIndex((earlier) => earlier.tabId === tabId) : -1;
    if (same >= 0) calls.splice(same, 1);
    calls.push(call);
  }
  return calls;
}

/** What a card's saved snapshot is filed under (with the session): the tab and
 *  what it showed, so a tab id reused for other files never shows the old picture. */
export function visualizeCardThumbnailLine(call: VisualizeCardCall): string {
  const shown = call.content
    ? `${call.content.kind}:${call.content.title ?? ''}`
    : call.targets.map(normalized).join('|');
  return `visualize|${call.tabId}|${shown}`;
}

/** First letter (or digit) of a title, upper-cased, for the placeholder tile. */
export function monogramLetter(title: string): string {
  const letter = /[\p{L}\p{N}]/u.exec(title)?.[0] ?? '';
  return letter.toLocaleUpperCase() || '·';
}

/** A stable tint (0-359) per title. */
export function monogramHue(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
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

const normalized = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '');
/** Same file: equal, or one is the other's project-relative tail (a remote
 *  client sees cwd-relative targets where the agent may have named absolute ones). */
function sameTarget(a: string, b: string): boolean {
  const left = normalized(a);
  const right = normalized(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** The live panel tab a card stands for: its id, showing the same files.
 *  Null once that tab was closed (or its id now names other files). */
export function visualizeCardTab(state: VisualizeSessionState, call: VisualizeCardCall): VisualizeTabView | null {
  if (!call.tabId) return null;
  const tab = state.tabs.find((candidate) => candidate.id === call.tabId);
  if (!tab) return null;
  const live = tab.panes.filter((pane) => pane.version === undefined);
  if (call.content) {
    // Inline tabs are identified by their title (re-opening it is a new
    // version of the same tab) and kind.
    const shown = live[0]?.inline;
    return live.length === 1 && shown?.kind === call.content.kind && shown.title === call.content.title ? tab : null;
  }
  if (live.length !== call.targets.length) return null;
  return live.every((pane, index) => sameTarget(pane.target, call.targets[index])) ? tab : null;
}

const KIND_BY_EXTENSION: Record<string, VisualizePaneKind> = {
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  avif: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  odt: 'document',
  ods: 'document',
  odp: 'document',
};

/** The card's icon: a live tab's pane kind, else guessed from the targets. */
export function visualizeCardKind(
  call: VisualizeCardCall,
  tab: VisualizeTabView | null
): VisualizePaneKind | VisualizeInlineKind | 'split' {
  if (call.content) return call.content.kind;
  if (call.targets.length > 1) return 'split';
  const live = tab?.panes.find((pane) => pane.version === undefined);
  if (live) return live.kind;
  const extension = /\.([a-z0-9]+)$/i.exec(call.targets[0] ?? '')?.[1]?.toLowerCase() ?? '';
  return KIND_BY_EXTENSION[extension] ?? 'document';
}

/** What an inline content is called (under its title on the card; alone on
 *  the tool row when it has no title). */
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

/** "vN" when the tab keeps more than one version: the shown one, else the newest. */
export function visualizeCardVersion(tab: VisualizeTabView | null): string {
  const versions = tab?.versions ?? [];
  if (versions.length < 2) return '';
  return `v${tab?.version ?? versions.at(-1)?.n}`;
}
