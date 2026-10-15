// How a `visualize` call reads on its transcript row: its arguments, the tab
// an open reported, and the title later rows name that tab by. Pure, so it is
// testable without a DOM.
import type { VisualizeInlineKind } from '../shared/visualize';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';
import { desktopToolActivitySurface, flattenedToolActivityItems, toolItemDone } from './transcript-tool-core';

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
