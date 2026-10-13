// The visualize panel's Elements list: the active HTML tab read as an outline,
// its interactive elements and its layout findings (the page script's
// `inspect`, the same reading the agent gets). Hovering a row outlines the
// element in the page; clicking one asks the pane's Comment layer to start a
// pin on it (only a trusted click does). Pages answer over postMessage, so
// the list works on the desktop and on a paired remote client alike; a page
// that is not running (a remote page before Run) simply has no reading.
import { AlertCircle, AlertTriangle, Info, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { VisualizeTabView } from '../shared/visualize';
import { postToPage, visualizeFeedbackPageMessage } from '../shared/visualize-feedback';
import type { InspectFinding, PageInspection } from '../shared/visualize-inspect';
import { t } from './i18n';
import { visualizeRequestId } from './visualize-feedback-gate';
import { requestVisualizeElementPin } from './visualize-elements-store';

/** How long a page has to answer before the list calls it unavailable. */
const ANSWER_TIMEOUT_MS = 1_500;
/** After a page announces itself, before it is read (its first layout). */
const READY_DELAY_MS = 300;
/** `ready` messages one pane may cause a read for, per second; the rest are dropped. */
const MAX_READY_PER_SECOND = 4;
/** Reads again (READY_DELAY_MS apart) of a pane that answered before it had a
 *  size, as a frame does while the panel is still opening. */
const EMPTY_VIEWPORT_RETRIES = 5;

export type PaneReading =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'error'; message: string }
  | { state: 'ready'; inspection: PageInspection };

/** Reads the tab's HTML panes through their page scripts and keeps the latest
 *  reading per pane. A page's `ready` triggers a read (a reload or a remote
 *  Run), `refresh` reads again, `highlight` outlines an element. */
export function useVisualizeInspection({ body, tab }: { body: HTMLElement | null; tab: VisualizeTabView | null }) {
  const [readings, setReadings] = useState<Record<number, PaneReading>>({});
  const open = useRef(new Map<string, { pane: number; source: Window; timer: ReturnType<typeof setTimeout> }>());
  const live = useRef({ body, tab });
  live.current = { body, tab };
  const tabKey = tab ? `${tab.id}:${tab.revision}:${tab.panes.length}` : '';

  const frameOf = useCallback((index: number): HTMLIFrameElement | null => {
    return live.current.body?.querySelector<HTMLIFrameElement>(`[data-visualize-pane="${index}"] iframe`) ?? null;
  }, []);

  // At most one request in flight per pane; a read asked for meanwhile runs
  // once, after it. `ready` messages are debounced per pane and a flood of
  // them (a page that keeps announcing itself) is dropped.
  const queued = useRef(new Set<number>());
  const readyTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const readyTimes = useRef(new Map<number, number[]>());
  const done = useRef<(index: number) => void>(() => {});
  const emptyRetries = useRef(new Map<number, number>());

  const read = useCallback(
    (index: number) => {
      const frame = frameOf(index);
      const source = frame?.contentWindow;
      if (!frame || !source || live.current.tab?.panes[index]?.kind !== 'html') return;
      for (const request of open.current.values()) {
        if (request.pane === index) {
          queued.current.add(index);
          return;
        }
      }
      const id = visualizeRequestId();
      const timer = setTimeout(() => {
        if (!open.current.delete(id)) return;
        setReadings((current) =>
          current[index]?.state === 'ready' ? current : { ...current, [index]: { state: 'unavailable' } }
        );
        done.current(index);
      }, ANSWER_TIMEOUT_MS);
      open.current.set(id, { pane: index, source, timer });
      setReadings((current) =>
        current[index]?.state === 'ready' ? current : { ...current, [index]: { state: 'loading' } }
      );
      postToPage(frame, { type: 'inspect', id });
    },
    [frameOf]
  );
  done.current = (index: number) => {
    if (queued.current.delete(index)) read(index);
  };

  const refresh = useCallback(() => {
    live.current.tab?.panes.forEach((pane, index) => {
      if (pane.kind === 'html') read(index);
    });
  }, [read]);

  // A different tab, or a reloaded one, starts over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabKey is the reset trigger
  useEffect(() => {
    setReadings({});
    for (const request of open.current.values()) clearTimeout(request.timer);
    open.current.clear();
    queued.current.clear();
    readyTimes.current.clear();
    for (const timer of readyTimers.current.values()) clearTimeout(timer);
    readyTimers.current.clear();
    emptyRetries.current.clear();
  }, [tabKey]);

  useEffect(() => {
    if (!body) return;
    const onMessage = (event: MessageEvent) => {
      const message = visualizeFeedbackPageMessage(event.data);
      if (!message || !event.source) return;
      if (message.type === 'ready') {
        for (const cell of body.querySelectorAll<HTMLElement>('[data-visualize-pane]')) {
          if (cell.querySelector('iframe')?.contentWindow !== event.source) continue;
          const index = Number(cell.dataset.visualizePane);
          const now = performance.now();
          const recent = (readyTimes.current.get(index) ?? []).filter((at) => now - at < 1_000);
          readyTimes.current.set(index, recent);
          if (recent.length >= MAX_READY_PER_SECOND) continue;
          recent.push(now);
          clearTimeout(readyTimers.current.get(index));
          readyTimers.current.set(
            index,
            setTimeout(() => {
              readyTimers.current.delete(index);
              read(index);
            }, READY_DELAY_MS)
          );
        }
        return;
      }
      if (message.type !== 'inspected') return;
      const request = open.current.get(message.id);
      if (!request || request.source !== event.source) return;
      clearTimeout(request.timer);
      open.current.delete(message.id);
      const { inspection } = message;
      setReadings((current) => ({
        ...current,
        [request.pane]:
          'error' in inspection ? { state: 'error', message: inspection.error } : { state: 'ready', inspection },
      }));
      done.current(request.pane);
      const pane = request.pane;
      const tries = emptyRetries.current.get(pane) ?? 0;
      if (
        !('error' in inspection) &&
        (inspection.viewport.width === 0 || inspection.viewport.height === 0) &&
        tries < EMPTY_VIEWPORT_RETRIES
      ) {
        emptyRetries.current.set(pane, tries + 1);
        clearTimeout(readyTimers.current.get(pane));
        readyTimers.current.set(
          pane,
          setTimeout(() => {
            readyTimers.current.delete(pane);
            read(pane);
          }, READY_DELAY_MS)
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [body, read]);

  useEffect(
    () => () => {
      for (const request of open.current.values()) clearTimeout(request.timer);
      for (const timer of readyTimers.current.values()) clearTimeout(timer);
    },
    []
  );

  const highlight = useCallback(
    (index: number, selector: string | null) => {
      const frame = frameOf(index);
      if (frame) postToPage(frame, { type: 'highlight', selector });
    },
    [frameOf]
  );

  const findingCount = useMemo(
    () =>
      Object.values(readings).reduce(
        (sum, reading) => (reading.state === 'ready' ? sum + reading.inspection.findingCount : sum),
        0
      ),
    [readings]
  );
  return { readings, refresh, highlight, findingCount };
}

const SEVERITY_ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;

function headingTag(level: number): string {
  return `h${level}`;
}

function unreadyMessage(reading: Exclude<PaneReading, { state: 'ready' }>): string {
  if (reading.state === 'loading') return t('Reading the page…');
  if (reading.state === 'error') return reading.message;
  return t('This page is not running, so its elements cannot be listed.');
}

function FindingRow({
  finding,
  onHover,
  onPin,
}: {
  finding: InspectFinding;
  onHover(selector: string | null): void;
  onPin(selector: string, trusted: boolean): void;
}) {
  const Icon = SEVERITY_ICON[finding.severity];
  return (
    <li>
      <button
        type="button"
        className={`visualize-elements-row is-${finding.severity}`}
        onMouseEnter={() => onHover(finding.selector)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(finding.selector)}
        onBlur={() => onHover(null)}
        onClick={(event) => onPin(finding.selector, event.nativeEvent.isTrusted)}
      >
        <Icon size={13} aria-label={finding.severity} />
        <span className="visualize-elements-text">{finding.message}</span>
        <code>{finding.selector}</code>
      </button>
    </li>
  );
}

function InspectionReport({
  inspection,
  hover,
  pin,
}: {
  inspection: PageInspection;
  hover(selector: string | null): void;
  pin(selector: string, trusted: boolean): void;
}) {
  return (
    <>
      <div className="visualize-elements-meta">
        {inspection.viewport.width}×{inspection.viewport.height}
      </div>
      <h4>
        {t('Findings')} ({inspection.findingCount})
      </h4>
      {inspection.findings.length ? (
        <ul>
          {inspection.findings.map((finding, at) => (
            <FindingRow
              // biome-ignore lint/suspicious/noArrayIndexKey: findings repeat (kind, selector, text) and never reorder
              key={`${at}:${finding.kind}:${finding.selector}`}
              finding={finding}
              onHover={hover}
              onPin={pin}
            />
          ))}
        </ul>
      ) : (
        <p className="visualize-elements-empty">{t('No layout findings.')}</p>
      )}
      {inspection.outline.length ? (
        <>
          <h4>{t('Outline')}</h4>
          <ul>
            {inspection.outline.map((item) => (
              <li key={`${item.kind}:${item.selector}:${item.name}`} style={{ paddingInlineStart: item.depth * 12 }}>
                <button
                  type="button"
                  className="visualize-elements-row"
                  onMouseEnter={() => hover(item.selector)}
                  onMouseLeave={() => hover(null)}
                  onFocus={() => hover(item.selector)}
                  onBlur={() => hover(null)}
                  onClick={(event) => pin(item.selector, event.nativeEvent.isTrusted)}
                >
                  <span className="visualize-elements-role">
                    {item.kind === 'landmark' ? item.role : headingTag(item.level)}
                  </span>
                  <span className="visualize-elements-text">{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>
        {t('Interactive')} ({inspection.elementCount})
      </h4>
      <ul>
        {inspection.elements.map((element) => (
          <li key={`${element.selector}:${element.x}:${element.y}`}>
            <button
              type="button"
              className="visualize-elements-row"
              onMouseEnter={() => hover(element.selector)}
              onMouseLeave={() => hover(null)}
              onFocus={() => hover(element.selector)}
              onBlur={() => hover(null)}
              onClick={(event) => pin(element.selector, event.nativeEvent.isTrusted)}
            >
              <span className="visualize-elements-role">{element.role}</span>
              <span className="visualize-elements-text">{element.name || '—'}</span>
              <code>{element.selector}</code>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The Elements list of the active tab (every HTML pane, labelled when more
 *  than one). */
export function VisualizeElements({
  tab,
  readings,
  refresh,
  highlight,
  onClose,
  onPin,
}: {
  tab: VisualizeTabView;
  readings: Record<number, PaneReading>;
  refresh(): void;
  highlight(pane: number, selector: string | null): void;
  onClose(): void;
  /** A trusted click on a row: start a pin on the element. */
  onPin(pane: number, selector: string): void;
}) {
  const htmlPanes = tab.panes.map((pane, index) => ({ pane, index })).filter(({ pane }) => pane.kind === 'html');
  // The list leaves no outline behind when it closes.
  const lastHighlight = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup only, on unmount
  useEffect(
    () => () => {
      if (lastHighlight.current !== null) highlight(lastHighlight.current, null);
    },
    []
  );
  return (
    <section className="visualize-elements" aria-label={t('Elements')}>
      <header className="visualize-elements-head">
        <span className="visualize-elements-title">{t('Elements')}</span>
        <button type="button" aria-label={t('Refresh')} data-tooltip={t('Refresh')} onClick={refresh}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
        <button type="button" aria-label={t('Close')} data-tooltip={t('Close')} onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </header>
      {htmlPanes.map(({ pane, index }) => {
        const reading = readings[index] ?? { state: 'loading' as const };
        const hover = (selector: string | null) => {
          lastHighlight.current = selector === null ? null : index;
          highlight(index, selector);
        };
        const pin = (selector: string, trusted: boolean) => {
          if (trusted) onPin(index, selector);
        };
        return (
          <div key={`${index}:${pane.url}`} className="visualize-elements-pane">
            {htmlPanes.length > 1 ? <div className="visualize-elements-pane-label">{pane.label}</div> : null}
            {reading.state === 'ready' ? (
              <InspectionReport inspection={reading.inspection} hover={hover} pin={pin} />
            ) : (
              <p className="visualize-elements-empty">{unreadyMessage(reading)}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** A trusted row click: turn Comment mode on (its layer takes the request). */
export function startElementPin(
  tabId: string,
  pane: number,
  selector: string,
  setComment: (on: boolean) => void
): void {
  requestVisualizeElementPin({ tabId, pane, selector });
  setComment(true);
}
