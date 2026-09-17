import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DesktopCapability } from '../shared/contract';
import { t } from './i18n';
import { record } from './record-utils';
// @ts-expect-error Shared context map has no separate declaration file.
import { buildContextMap } from '../../../../src/ui/context-inspection.mjs';

type Category = { key: string; label: string; tokens: number; estimatedTokens?: number; count: number };
type Entry = {
  id: string; category: string; label: string; tokens: number; estimatedTokens?: number; kind: string;
  group?: string; state?: string; role?: string; ordinal?: number; name?: string;
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

export function groupLabel(group: string): string {
  return t(GROUP_LABELS[group] || group);
}
export type ContextRequest = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
type Preview = { id: string; text: string; truncated?: boolean; stale?: boolean };

const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
};

// An assistant turn that called tools carries their results; the row's
// sub-line names them with their share so the pair reads as one turn.
export function toolResultLine(entry: Entry): string {
  return (entry.toolResults || []).map((row) => `${row.name} ≈${row.tokens.toLocaleString()}`).join(' · ');
}

// Message rows carry role + ordinal so the row reads in the UI language.
// Everything else is content: tool names are identifiers and prompt section
// headings are the user's own text, so both stay verbatim. Only the synthetic
// framing row has a translatable label.
export function entryLabel(entry: Entry): string {
  if (entry.kind === 'message' && entry.role) {
    const role = t(ROLE_LABELS[entry.role] || 'Message');
    return `${role} ${entry.ordinal ?? ''}`.trim() + (entry.name ? ` · ${entry.name}` : '');
  }
  if (entry.kind === 'overhead') return t(entry.label);
  return entry.label;
}

export function ContextInspector({ inspection, windowTokens, reserveTokens, request }: {
  inspection: ContextInspection;
  windowTokens: number;
  reserveTokens: number;
  request?: ContextRequest;
}) {
  const [category, setCategory] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; }, []);
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
  const map = buildContextMap(inspection.categories, { windowTokens, reserveTokens });
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
  const openPreview = async (entry: Entry) => {
    if (!request) return;
    const ticket = ++sequence.current;
    setPreview({ id: entry.id, text: t('Loading preview…') });
    try {
      const result = record(await request('contextStatus', [{ inspect: true, entryId: entry.id, revision: inspection.revision }]));
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
  const mapNote = [
    t('Each block represents approximately {{tokens}} tokens.', { tokens: Math.ceil(map.blockTokens).toLocaleString() }),
    t('Category estimates are not provider measurements.'),
    map.overflow ? t('Estimated content exceeds the context window.') : '',
  ].filter(Boolean).join(' ');
  const selected = inspection.categories.find((row) => row.key === category);
  const previewEntry = preview ? entries.find((item) => item.id === preview.id) : undefined;
  const closePreview = () => { sequence.current += 1; setPreview(null); };
  // Master/detail: categories on the left are the only navigation, and the
  // right pane always shows the result of the last choice — a placeholder,
  // the entry list, or one entry's preview with a way back to the list.
  let detail;
  if (!selected) {
    detail = (
      <div className="context-detail-empty">
        <p>{t('Select a category to list its entries here.')}</p>
      </div>
    );
  } else if (preview) {
    // Same 48px bar as the dialog header: back glyph, entry name, size.
    detail = (
      <section className="context-entry-section context-entry-preview" aria-label={t('Context entries')} aria-live="polite">
        <header className="context-detail-bar">
          <button type="button" className="context-detail-icon" onClick={closePreview} aria-label={t('Close preview')}>
            <ChevronLeft size={16} />
          </button>
          <h3>{previewEntry ? entryLabel(previewEntry) : ''}</h3>
          <span>{previewEntry ? `≈${previewEntry.tokens.toLocaleString()}` : ''}</span>
        </header>
        {preview.truncated ? <p className="context-inspector-note context-detail-note">{t('Preview limited to 32,000 characters.')}</p> : null}
        <pre tabIndex={0}>{preview.text}</pre>
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
      const rank = (key: string) => { const index = GROUP_ORDER.indexOf(key); return index < 0 ? GROUP_ORDER.length : index; };
      const byOrder = rank(a) - rank(b);
      if (byOrder) return byOrder;
      return bRows.reduce((sum, row) => sum + row.tokens, 0) - aRows.reduce((sum, row) => sum + row.tokens, 0);
    });
    const grouped = ordered.length > 1;
    const largest = grouped
      ? ordered.reduce((best, current) =>
          current[1].reduce((sum, row) => sum + row.tokens, 0) > best[1].reduce((sum, row) => sum + row.tokens, 0) ? current : best
        )[0]
      : '';
    const isOpen = (key: string) =>
      expanded[key] ?? (entries.length <= COLLAPSE_THRESHOLD || key === largest);
    const row = (entry: Entry) => (
      <button type="button" key={entry.id} disabled={!request} onClick={() => void openPreview(entry)}
        data-state={entry.state} title={tokenTitle(entry)}>
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
          <span title={tokenTitle(selected)}>{t('{{count}} items', { count: selected.count })} · ≈{selected.tokens.toLocaleString()}</span>
          <button type="button" className="context-detail-icon" onClick={() => selectCategory('')} aria-label={t('Close entries')}>
            <X size={16} />
          </button>
        </header>
        <div className="context-entry-list">
          {grouped
            ? ordered.map(([key, rows]) => {
                const open = isOpen(key);
                const total = rows.reduce((sum, item) => sum + item.tokens, 0);
                return (
                  <div className="context-entry-group" key={key} data-open={open ? 'true' : undefined}>
                    <button type="button" className="context-entry-group-head" aria-expanded={open}
                      onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}>
                      <ChevronRight size={14} aria-hidden="true" />
                      <span>{groupLabel(key)}</span>
                      <small>{t('{{count}} items', { count: rows.length })}</small>
                      <strong>{key === 'deferred' ? '—' : `≈${total.toLocaleString()}`}</strong>
                    </button>
                    {open ? rows.map(row) : null}
                  </div>
                );
              })
            : entries.map(row)}
          {!entries.length && <p>{t('No entries.')}</p>}
        </div>
      </section>
    );
  }
  return (
    <section className="context-inspector" aria-label={t('Context inspector')}>
      <aside className="context-inspector-nav">
        <div className="context-block-map" role="img" aria-label={`${t('Estimated context composition')}. ${mapNote}`} title={mapNote}>
          {map.cells.map((key: string, index: number) => <i key={index} data-context-key={key} />)}
        </div>
        <div className="context-mix-list">
          {rankedCategories.map((row) => (
            <button type="button" className="context-mix-row" key={row.key} data-context-key={row.key}
              data-empty={row.tokens > 0 ? undefined : 'true'}
              aria-pressed={category === row.key} onClick={() => selectCategory(row.key)}
              aria-label={`${t(row.label)} · ${t('{{count}} items', { count: row.count })} · ≈${row.tokens.toLocaleString()}`}>
              <i aria-hidden="true" />
              <span>{t(row.label)}<small>{t('{{count}} items', { count: row.count })}</small></span>
              <em>{percentLabel(row.tokens)}</em>
              <strong title={tokenTitle(row)}>≈{row.tokens.toLocaleString()}</strong>
            </button>
          ))}
          <div className="context-mix-remainder">
            <div className="context-mix-row" data-context-key="free">
              <i aria-hidden="true" /><span>{t('Free space')}</span>
              <em>{percentLabel(freeTokens)}</em><strong>≈{freeTokens.toLocaleString()}</strong>
            </div>
            <div className="context-mix-row" data-context-key="autocompact">
              <i aria-hidden="true" /><span>{t('Autocompact buffer')}</span>
              <em>{percentLabel(reserveTokens)}</em><strong>{reserveTokens.toLocaleString()}</strong>
            </div>
          </div>
        </div>
      </aside>
      <div className="context-inspector-detail">{detail}</div>
    </section>
  );
}
