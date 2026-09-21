import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DesktopCapability } from '../shared/contract';
import { t } from './i18n';
import { record } from './record-utils';
import MarkdownBody from './MarkdownBody';
import { CopyControl } from './transcript-primitives';
// @ts-expect-error Shared context map has no separate declaration file.
import { buildContextMap } from '../../../../src/ui/context-inspection.mjs';

type Category = { key: string; label: string; tokens: number; estimatedTokens?: number; count: number };
type Entry = {
  id: string;
  category: string;
  label: string;
  tokens: number;
  estimatedTokens?: number;
  kind: string;
  group?: string;
  state?: string;
  role?: string;
  ordinal?: number;
  name?: string;
  toolResults?: { name: string; tokens: number }[];
};
type Calibration = {
  source: 'provider' | 'estimate';
  measuredTokens?: number;
  ratio?: number;
  coveredMessages?: number;
  estimatedTokens?: number;
};
export type ContextInspection = {
  revision: string;
  categories: Category[];
  entries: Entry[];
  estimatedTokens: number;
  calibration?: Calibration;
};

const GROUP_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  summary: 'Compaction summary',
  instruction: 'Instructions',
  reminder: 'System reminder',
  tool: 'Tool result',
  native: 'Provider built-in',
  active: 'Always sent',
  loaded: 'Loaded on demand',
  deferred: 'Deferred, not counted',
  overhead: 'Request framing',
};
// Groups a category's entries in a fixed reading order: what always costs
// first, what was loaded next, and what costs nothing last.
const GROUP_ORDER = ['native', 'active', 'loaded', 'overhead', 'deferred'];
const COLLAPSE_THRESHOLD = 12;
// Tool names shown on a turn's sub-line before the tail becomes "+N".
const TOOL_SUMMARY_LIMIT = 3;

// A group is either one of the known kinds above or a tool name. Tool names are
// identifiers, so an unknown key is printed as it came — never run through the
// catalog, where a lowercase word could collide with an unrelated phrase.
export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ? t(GROUP_LABELS[group]) : group;
}
export type ContextRequest = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
type Preview = { id: string; text: string; truncated?: boolean; stale?: boolean };

export function contextPreviewMarkdown(text: string, kind?: string): string {
  if (kind !== 'tool') return text;
  // Tool previews already contain indented JSON, including possibly truncated
  // schemas. A longer fence preserves literal backticks in descriptions.
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((run) => run.length + 1)));
  return `${fence}json\n${text}\n${fence}`;
}

const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool result',
};

// Tool results are rows of their own now, so this sub-line is only a trace of
// which tools the turn called — the sizes live in the Tool results category.
// One name per tool, most-used first, and only the leading few: listing every
// call let the line, and with it the row, grow without bound (user: 저것 때문에
// 아이템 길이가 달라져).
export function toolResultLine(entry: Entry): string {
  const calls = new Map<string, number>();
  for (const row of entry.toolResults || []) calls.set(row.name, (calls.get(row.name) || 0) + 1);
  const ranked = [...calls].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const line = ranked.slice(0, TOOL_SUMMARY_LIMIT).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  if (ranked.length > TOOL_SUMMARY_LIMIT) line.push(`+${ranked.length - TOOL_SUMMARY_LIMIT}`);
  return line.join(' · ');
}

// Message and attachment rows carry role + ordinal so the row reads in the UI
// language. Everything else is content: tool names are identifiers and prompt
// section headings are the user's own text, so both stay verbatim. Only the
// synthetic framing row has a translatable label.
function entryLabel(entry: Entry): string {
  if (entry.kind === 'attachment') {
    const owner = entry.role ? `${t(ROLE_LABELS[entry.role] || 'Message')} ${entry.ordinal ?? ''}`.trim() : '';
    return owner ? `${owner} · ${entry.label}` : entry.label;
  }
  if (entry.kind === 'message' && entry.role) {
    const role = t(ROLE_LABELS[entry.role] || 'Message');
    return `${role} ${entry.ordinal ?? ''}`.trim() + (entry.name ? ` · ${entry.name}` : '');
  }
  if (entry.kind === 'overhead' || entry.kind === 'reasoning') return t(entry.label);
  return entry.label;
}

export function ContextInspector({
  inspection,
  windowTokens,
  request,
}: {
  inspection: ContextInspection;
  windowTokens: number;
  request?: ContextRequest;
}) {
  const [category, setCategory] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Which category the pointer is over in the block map, so its blocks and its
  // row in the list light up together.
  const [hovered, setHovered] = useState('');
  // The floating bubble that names the block under the pointer, positioned
  // against the map rather than the viewport so it travels with the dialog.
  const [bubble, setBubble] = useState<{ x: number; y: number; flip: boolean; text: string } | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    []
  );
  // A new revision means the transcript changed under us. The category list
  // keeps its DOM (remounting it on every refresh made the dialog flash on
  // open); only the preview — which was fetched against the OLD revision —
  // is dropped, together with any in-flight fetch for it. The selected
  // category survives as long as it still exists.
  const revision = useRef(inspection.revision);
  if (revision.current !== inspection.revision) {
    revision.current = inspection.revision;
    sequence.current += 1;
    if (preview) setPreview(null);
    if (category && !inspection.categories.some((row) => row.key === category)) setCategory('');
  }
  const map = buildContextMap(inspection.categories, { windowTokens });
  const selectCategory = (key: string) => {
    sequence.current += 1;
    setPreview(null);
    setExpanded({});
    setCategory(key);
  };
  const calibration = inspection.calibration;
  const calibrated = calibration?.source === 'provider';
  const tokenTitle = (entry: { tokens: number; estimatedTokens?: number }) =>
    calibrated && entry.estimatedTokens !== undefined && entry.estimatedTokens !== entry.tokens
      ? t('Raw estimate: ≈{{tokens}}', { tokens: entry.estimatedTokens.toLocaleString() })
      : undefined;
  // The list stays put until the content is actually here. Swapping it for a
  // "Loading preview…" pane first meant one click resized the pane twice
  // (user: 상세항목 눌러서 들어갈때 툭 튀고); the read is a local snapshot, so
  // the wait is a frame, not a spinner's worth of time.
  const openPreview = async (entry: Entry) => {
    if (!request) return;
    const ticket = ++sequence.current;
    try {
      const result = record(
        await request('contextStatus', [{ inspect: true, entryId: entry.id, revision: inspection.revision }])
      );
      if (ticket !== sequence.current) return;
      const next = record(record(result.inspection).preview);
      setPreview({
        id: entry.id,
        text: next.stale ? t('Context changed. Select the entry again.') : String(next.text || ''),
        stale: next.stale === true,
        truncated: next.truncated === true,
      });
    } catch {
      if (ticket === sequence.current) setPreview({ id: entry.id, text: t('Preview unavailable.') });
    }
  };
  const entries = inspection.entries.filter((entry) => entry.category === category);
  // Ranked by estimated size for scanning; empty categories fall to the tail
  // and stay visible, so the set of categories remains stable.
  const rankedCategories = [...inspection.categories].sort((a, b) => b.tokens - a.tokens);
  const freeTokens = Math.max(0, windowTokens - inspection.estimatedTokens);
  const percentLabel = (tokens: number) =>
    windowTokens > 0 ? `${Math.round((tokens / windowTokens) * 1000) / 10}%` : '';
  // Every block already knows its category, so hovering one can say which
  // share it belongs to and how big that share is — the same numbers as the
  // row in the list (user: 그리드에 호버하면 팝업 ... 어떤거 얼마나 먹었는지).
  const cellKey = (node: EventTarget | null) => (node instanceof HTMLElement ? node.dataset.contextKey || '' : '');
  const cellSummary = (key: string) => {
    if (key === 'free') {
      return [t('Free space'), percentLabel(freeTokens), `≈${freeTokens.toLocaleString()}`].filter(Boolean).join(' · ');
    }
    const row = inspection.categories.find((item) => item.key === key);
    if (!row) return '';
    return [
      t(row.label),
      t('{{count}} items', { count: row.count }),
      percentLabel(row.tokens),
      `≈${row.tokens.toLocaleString()}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  // Hovering a block answers in place (user: 호버하면 플로팅되는 팝업) instead
  // of only lighting its run up, so the map can be read without tracking the
  // colour back to a row in the list.
  const trackBubble = (mapNode: HTMLElement, target: EventTarget | null) => {
    const cell = target instanceof HTMLElement ? target : null;
    const key = cell?.dataset.contextKey || '';
    if (!cell || !key) {
      setHovered('');
      setBubble(null);
      return;
    }
    setHovered(key);
    const mapRect = mapNode.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const top = cellRect.top - mapRect.top;
    // Keep the bubble inside the map — an edge block would otherwise push it
    // past the dialog — and hang it under the block on the top rows, where
    // there is nothing above to hold it.
    const flip = top <= 28;
    const centre = cellRect.left - mapRect.left + cellRect.width / 2;
    setBubble({
      x: Math.min(Math.max(centre, 80), Math.max(80, mapRect.width - 80)),
      y: flip ? top + cellRect.height : top,
      flip,
      text: cellSummary(key),
    });
  };
  const mapNote = [
    t('Each block represents approximately {{tokens}} tokens.', {
      tokens: Math.ceil(map.blockTokens).toLocaleString(),
    }),
    t('Category estimates are not provider measurements.'),
    map.overflow ? t('Estimated content exceeds the context window.') : '',
  ]
    .filter(Boolean)
    .join(' ');
  const selected = inspection.categories.find((row) => row.key === category);
  const previewEntry = preview ? entries.find((item) => item.id === preview.id) : undefined;
  const closePreview = () => {
    sequence.current += 1;
    setPreview(null);
  };
  // Master/detail: categories on the left are the only navigation, and the
  // right pane always shows the result of the last choice — a placeholder,
  // the entry list, or one entry's preview with a way back to the list.
  let detail: ReactNode;
  if (!selected) {
    detail = (
      <div className="context-detail-empty">
        <p>{t('Select a category to list its entries here.')}</p>
      </div>
    );
  } else if (preview) {
    // Same 48px bar as the dialog header: back glyph, entry name, size.
    detail = (
      <section
        className="context-entry-section context-entry-preview"
        aria-label={t('Context entries')}
        aria-live="polite"
      >
        <header className="context-detail-bar">
          <button type="button" className="context-detail-icon" onClick={closePreview} aria-label={t('Close preview')}>
            <ChevronLeft size={16} />
          </button>
          {/* The name is content — a tool name, a prompt heading — so the DOM
              translation pass must not swap it for a catalog phrase. */}
          <h3 data-i18n-skip>{previewEntry ? entryLabel(previewEntry) : ''}</h3>
          <span>{previewEntry ? `≈${previewEntry.tokens.toLocaleString()}` : ''}</span>
        </header>
        {preview.truncated ? (
          <p className="context-inspector-note context-detail-note">{t('Preview limited to 32,000 characters.')}</p>
        ) : null}
        <div className="context-preview-content markdown" data-scrollable data-i18n-skip tabIndex={0}>
          <MarkdownBody
            key={preview.id}
            text={contextPreviewMarkdown(preview.text, previewEntry?.kind)}
            copyControl={CopyControl}
          />
        </div>
      </section>
    );
  } else {
    // Group entries like the reference tools do: message rows by role (tool
    // results already live inside their assistant turn), tool rows by how
    // they ride the wire.
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = entry.group || '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }
    const ordered = [...groups.entries()].sort(([a, aRows], [b, bRows]) => {
      const rank = (key: string) => {
        const index = GROUP_ORDER.indexOf(key);
        return index < 0 ? GROUP_ORDER.length : index;
      };
      const byOrder = rank(a) - rank(b);
      if (byOrder) return byOrder;
      return bRows.reduce((sum, row) => sum + row.tokens, 0) - aRows.reduce((sum, row) => sum + row.tokens, 0);
    });
    const grouped = ordered.length > 1;
    const groupTokens = (group: (typeof ordered)[number]) => group[1].reduce((sum, row) => sum + row.tokens, 0);
    let largest = '';
    if (grouped) {
      largest = ordered.reduce((best, current) => (groupTokens(current) > groupTokens(best) ? current : best))[0];
    }
    const isOpen = (key: string) => expanded[key] ?? (entries.length <= COLLAPSE_THRESHOLD || key === largest);
    const row = (entry: Entry) => (
      <button
        type="button"
        key={entry.id}
        disabled={!request}
        onClick={() => void openPreview(entry)}
        data-state={entry.state}
        title={tokenTitle(entry)}
      >
        <span>
          {entryLabel(entry)}
          {entry.state === 'deferred' ? <small className="context-entry-badge">{t('Deferred')}</small> : null}
          {entry.toolResults?.length ? <small className="context-entry-tools">{toolResultLine(entry)}</small> : null}
        </span>
        <strong>{entry.state === 'deferred' ? '—' : `≈${entry.tokens.toLocaleString()}`}</strong>
      </button>
    );
    detail = (
      <section className="context-entry-section" aria-label={t('Context entries')}>
        <header className="context-detail-bar">
          <i aria-hidden="true" data-context-key={selected.key} />
          <h3>{t(selected.label)}</h3>
          <span title={tokenTitle(selected)}>
            {t('{{count}} items', { count: selected.count })} · ≈{selected.tokens.toLocaleString()}
          </span>
          <button
            type="button"
            className="context-detail-icon"
            onClick={() => selectCategory('')}
            aria-label={t('Close entries')}
          >
            <X size={16} />
          </button>
        </header>
        <div className="context-entry-list" data-i18n-skip>
          {!grouped && entries.map(row)}
          {grouped &&
            ordered.map(([key, rows]) => {
              const open = isOpen(key);
              const total = rows.reduce((sum, item) => sum + item.tokens, 0);
              return (
                <div className="context-entry-group" key={key} data-open={open ? 'true' : undefined}>
                  <button
                    type="button"
                    className="context-entry-group-head"
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                    <span>{groupLabel(key)}</span>
                    <small>{t('{{count}} items', { count: rows.length })}</small>
                    <strong>{key === 'deferred' ? '—' : `≈${total.toLocaleString()}`}</strong>
                  </button>
                  {open ? rows.map(row) : null}
                </div>
              );
            })}
          {!entries.length && <p>{t('No entries.')}</p>}
        </div>
      </section>
    );
  }
  return (
    <section className="context-inspector" aria-label={t('Context inspector')}>
      <aside className="context-inspector-nav">
        {/* The map is one image for assistive tech — the per-block hover copy is
            a pointer affordance, so the native title is gone (it would double
            up with the bubble) and the note rides the label. */}
        <div
          className="context-block-map"
          role="img"
          aria-label={`${t('Estimated context composition')}. ${mapNote}`}
          data-hover={hovered ? 'true' : undefined}
          onPointerOver={(event) => trackBubble(event.currentTarget, event.target)}
          onPointerLeave={() => {
            setHovered('');
            setBubble(null);
          }}
          onClick={(event) => {
            const key = cellKey(event.target);
            if (key && key !== 'free') selectCategory(key);
          }}
        >
          {map.cells.map((key: string, index: number) => (
            <i key={index} data-context-key={key} data-muted={hovered && hovered !== key ? 'true' : undefined} />
          ))}
          {bubble && (
            <span
              className="context-block-bubble"
              aria-hidden="true"
              data-flip={bubble.flip ? 'true' : undefined}
              style={{ left: `${bubble.x}px`, top: `${bubble.y}px` }}
            >
              {bubble.text}
            </span>
          )}
        </div>
        <div className="context-mix-list">
          {rankedCategories.map((row) => (
            <button
              type="button"
              className="context-mix-row"
              key={row.key}
              data-context-key={row.key}
              data-empty={row.tokens > 0 ? undefined : 'true'}
              data-hot={hovered === row.key ? 'true' : undefined}
              aria-pressed={category === row.key}
              onClick={() => selectCategory(row.key)}
              aria-label={`${t(row.label)} · ${t('{{count}} items', { count: row.count })} · ≈${row.tokens.toLocaleString()}`}
            >
              <i aria-hidden="true" />
              <span>
                {t(row.label)}
                <small>{t('{{count}} items', { count: row.count })}</small>
              </span>
              <em>{percentLabel(row.tokens)}</em>
              <strong title={tokenTitle(row)}>≈{row.tokens.toLocaleString()}</strong>
            </button>
          ))}
          <div className="context-mix-remainder">
            <div className="context-mix-row" data-context-key="free" data-hot={hovered === 'free' ? 'true' : undefined}>
              <i aria-hidden="true" />
              <span>{t('Free space')}</span>
              <em>{percentLabel(freeTokens)}</em>
              <strong>≈{freeTokens.toLocaleString()}</strong>
            </div>
          </div>
        </div>
      </aside>
      <div className="context-inspector-detail">{detail}</div>
    </section>
  );
}
