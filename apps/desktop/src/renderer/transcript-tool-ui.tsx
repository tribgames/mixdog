import {
  AppWindow,
  Bot,
  Brain,
  Brush,
  ChevronRight,
  Code2,
  FileSpreadsheet,
  GitBranch,
  Globe,
  Layers3,
  Monitor,
  PackageOpen,
  Plug,
  Settings2,
  Sparkles,
} from 'lucide-react';
import React, {
  Suspense,
  lazy,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { preloadMarkdownBody } from './markdown-body-loader';
import { LocalPathMention } from './MarkdownLink';
import { MxIcon } from './MxIcon';
import { formatElapsed } from './text-format';
import { CodeDiff } from './transcript-diff';
import { CopyControl, TextShimmer } from './transcript-primitives';
import { TranscriptArtifacts } from './transcript-artifacts-ui';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { linkOpenTarget } from './link-open-target';
import { toolActivityCallExpands, useToolActivityView, type ToolActivityExpansion } from './tool-activity-expansion';
import {
  ToolCode,
  ToolCommand,
  ToolFileList,
  ToolPanel,
  ToolSections,
  toolCodeRowsPlain,
} from './transcript-tool-panel';
import {
  desktopToolActivityBrowserPage,
  desktopToolActivitySummary,
  desktopToolActivityItemPresentation,
  flattenedToolActivityItems,
  isHookApprovalDenialToolItem,
  TOOL_DETAIL_LABELS,
  toolActivityIsCompleted,
  toolItemDone,
  type ToolActivityBrowserPage,
  type ToolCardModel,
} from './transcript-tool-model';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatToolSurface } from '../../../../src/runtime/shared/tool-surface.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolCardModel, deriveToolOutcomeTone, splitLineDeltaTokens } from '../../../../src/runtime/shared/tool-card-model.mjs';

interface DetailLinePart {
  text: string;
  delta?: '+' | '-';
}

const TOOL_DISCLOSURE_LIMIT = 1_000;
const toolDisclosureStates = new Map<string, boolean>();

function toolDisclosureKey(item: TranscriptItem, scope: string): string {
  const id = String(item.id ?? '').trim();
  return id ? `${scope}:${id}` : '';
}

function rememberToolDisclosure(key: string, open: boolean): void {
  if (!key) return;
  toolDisclosureStates.delete(key);
  toolDisclosureStates.set(key, open);
  while (toolDisclosureStates.size > TOOL_DISCLOSURE_LIMIT) {
    const oldest = toolDisclosureStates.keys().next().value;
    if (typeof oldest !== 'string') break;
    toolDisclosureStates.delete(oldest);
  }
}

// Disclosure state is visit-scoped and survives virtualized row remounts.
export function resetToolDisclosureScope(scope: string): void {
  if (!scope) return;
  const prefix = `${scope}:`;
  for (const key of [...toolDisclosureStates.keys()]) {
    if (key.startsWith(prefix)) toolDisclosureStates.delete(key);
  }
}

// The expansion view is part of the key: switching it starts from its own
// defaults, and switching back to a saved mode finds the rows as they were left.
function toolActivityDisclosureKey(items: readonly TranscriptItem[], scope: string, viewKey: string): string {
  const id = String(items[0]?.id ?? '').trim();
  return id ? `${scope}:${viewKey}:tool-activity:${id}` : '';
}

/** Open state remembered per disclosure key across virtualized remounts. The
 *  transcript row's ResizeObserver picks up the height a flip changes.
 *  `chosen` is false while the row only follows `defaultOpen`. */
function useRememberedDisclosure(
  disclosureKey: string,
  defaultOpen = false
): [open: boolean, toggle: () => void, chosen: boolean, keepOpen: () => void] {
  const read = () => (disclosureKey ? toolDisclosureStates.get(disclosureKey) : undefined);
  const [remembered, setRemembered] = useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read is a fresh closure over disclosureKey.
  useLayoutEffect(() => {
    setRemembered(read());
  }, [disclosureKey]);
  const open = remembered ?? defaultOpen;
  const choose = (next: boolean) => {
    rememberToolDisclosure(disclosureKey, next);
    setRemembered(next);
  };
  return [open, () => choose(!open), remembered !== undefined, () => choose(true)];
}

/** Disclosure in two steps so the body can animate: it is mounted before it
 *  expands and stays mounted until the collapse transition is over. */
function useToolActivityDisclosure(panelOpen: boolean): { rendered: boolean; expanded: boolean } {
  const [rendered, setRendered] = useState(panelOpen);
  const [expanded, setExpanded] = useState(panelOpen);
  useLayoutEffect(() => {
    if (panelOpen) {
      setRendered(true);
      // No frame clock (a headless DOM): expand on the next task instead.
      if (typeof window.requestAnimationFrame !== 'function') {
        const timer = window.setTimeout(() => setExpanded(true), 0);
        return () => window.clearTimeout(timer);
      }
      const frame = window.requestAnimationFrame(() => setExpanded(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = window.setTimeout(
      () => setRendered(false),
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 200
    );
    return () => window.clearTimeout(timer);
  }, [panelOpen]);
  return { rendered, expanded };
}

interface ToolActivityGroupProps {
  items: readonly TranscriptItem[];
  disclosureScope?: string;
}

/** The live projection rebuilds a group's items array on every tick from the
 *  same item objects; element identity is what decides a re-render. */
function sameToolActivityGroupProps(previous: ToolActivityGroupProps, next: ToolActivityGroupProps): boolean {
  if ((previous.disclosureScope ?? '') !== (next.disclosureScope ?? '')) return false;
  if (previous.items === next.items) return true;
  return (
    previous.items.length === next.items.length && previous.items.every((item, index) => item === next.items[index])
  );
}

/** The tool-group sparkle (4-point star) path, centred on (cx, cy). */
function sparklePath(cx: number, cy: number, r: number): string {
  const k = (value: number) => Math.round(value * 100) / 100;
  return `M${cx} ${cy - r}Q${k(cx + r * 0.16)} ${k(cy - r * 0.16)} ${cx + r} ${cy} ${k(cx + r * 0.16)} ${k(cy + r * 0.16)} ${cx} ${cy + r} ${k(cx - r * 0.16)} ${k(cy + r * 0.16)} ${cx - r} ${cy} ${k(cx - r * 0.16)} ${k(cy - r * 0.16)} ${cx} ${cy - r}Z`;
}

/** Running mark of a call row (which has no leading icon): the group icon's
 *  sparkle, twinkling until the result lands. */
function ToolWorkingSpark() {
  return (
    <svg className="tool-working-spark" width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <path className="tool-group-icon-star" d={sparklePath(6, 6, 5)} fill="currentColor" />
    </svg>
  );
}

/** When a tool call started (epoch ms). Transcript items carry their start as
 *  `at`; `startedAt` wins where a projection provides one. */
function toolItemStartedAt(item: { startedAt?: unknown; at?: unknown }): number {
  const value = Number(item.startedAt || item.at || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Elapsed (from 5s) while the work is pending, so the one-second tick stops
 *  with it. A group header animates its leading icon instead; a call row,
 *  which has none, carries the twinkling sparkle here (`spark`). */
function ToolWorkingStatus({ startedAt, spark = false }: { startedAt: number; spark?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsedMs = startedAt ? now - startedAt : 0;
  const showElapsed = elapsedMs >= 5_000;
  if (!showElapsed && !spark) return null;
  return (
    <span className="tool-working">
      {showElapsed && <span className="tool-working-elapsed">{formatElapsed(elapsedMs)}</span>}
      {spark && <ToolWorkingSpark />}
    </span>
  );
}

/** Sparkle + list glyph of a tool group. It stays still while the group runs:
 *  the shimmering title already carries the running state. */
function ToolGroupIcon() {
  const d = sparklePath(5, 6, 3.2);
  return (
    <svg
      className="tool-group-icon"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="tool-group-icon-star" d={d} fill="currentColor" stroke="none" />
      <circle className="tool-group-icon-dot" cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle className="tool-group-icon-dot" cx="5" cy="18" r="1.25" fill="currentColor" stroke="none" />
      <path className="tool-group-icon-line" d="M11 6h10" />
      <path className="tool-group-icon-line" d="M11 12h8" />
      <path className="tool-group-icon-line" d="M11 18h10" />
    </svg>
  );
}

/** Memoized: every TranscriptList render re-invokes renderRow for each row. */
export const ToolActivityGroup = React.memo(function ToolActivityGroup({
  items,
  disclosureScope = '',
}: ToolActivityGroupProps) {
  const { mode, key: viewKey } = useToolActivityView();
  const disclosureKey = toolActivityDisclosureKey(items, disclosureScope, viewKey);
  const calls = useMemo(() => flattenedToolActivityItems(items), [items]);
  const [open, toggleOpen] = useRememberedDisclosure(
    disclosureKey,
    calls.some((item) => toolActivityCallExpands(item, mode))
  );
  const { rendered, expanded } = useToolActivityDisclosure(open);
  const contentId = useId();
  const pending = items.some((item) => !toolItemDone(item));
  const summary = useMemo(() => desktopToolActivitySummary(items), [items]);
  const browserPage = useMemo(() => desktopToolActivityBrowserPage(items), [items]);
  const label = summary || t('Tool use');
  const pendingStartedAt = useMemo(() => {
    const starts = calls
      .filter((item) => !toolItemDone(item))
      .map(toolItemStartedAt)
      .filter((value) => value > 0);
    return starts.length ? Math.min(...starts) : 0;
  }, [calls]);

  return (
    <article className="tool-activity" data-surface="desktop" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="tool-header tool-activity-header"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="tool-icon">
          <ToolGroupIcon />
        </span>
        <span className="tool-title tool-activity-title" title={label}>
          <b>
            <TextShimmer text={label} active={pending} />
          </b>
        </span>
        {pending && (
          <span className="sr-only" role="status">
            {t('Running')}
          </span>
        )}
        {pending && <ToolWorkingStatus startedAt={pendingStartedAt} />}
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRight size={16} />
        </span>
      </button>
      {rendered && (
        <div className="tool-activity-reveal" data-expanded={expanded ? 'true' : 'false'}>
          <div className="tool-activity-reveal-clip">
            <div className="tool-activity-content" id={contentId}>
              <ToolActivityDetails items={calls} disclosureKey={disclosureKey} mode={mode} />
            </div>
          </div>
        </div>
      )}
      {browserPage && <ToolBrowserPageCard page={browserPage} sessionId={disclosureScope} />}
      <TranscriptArtifacts items={items} />
    </article>
  );
}, sameToolActivityGroupProps);

/** The page a turn left open in the browser pane, as a card under its tool
 *  group: where it was, and one press to bring the pane back to it. Without
 *  it the only trace of a page was a tool row, and reopening the pane after
 *  closing it meant finding the address again. Hidden where no pane can be
 *  revealed (a draft with no session, a paired phone). */
function ToolBrowserPageCard({ page, sessionId }: { page: ToolActivityBrowserPage; sessionId: string }) {
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable() }) !== 'pane') return null;
  return (
    <div className="transcript-browser-page">
      <span className="transcript-browser-page-icon" aria-hidden="true">
        <Globe size={16} />
      </span>
      <span className="transcript-browser-page-copy" title={page.url}>
        <b>{page.host}</b>
        <small>{[page.path, t('Opened in browser')].filter(Boolean).join(' · ')}</small>
      </span>
      <button
        type="button"
        className="transcript-browser-page-open"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => requestBrowserPage(sessionId, page.url)}
      >
        {t('Open')}
      </button>
    </div>
  );
}

function activityItemKey(item: TranscriptItem, index: number): string {
  return String(item.id ?? `${String(item.name || 'tool')}:${index}`);
}

function disclosureChildKey(parent: string, id: string): string {
  return parent ? `${parent}:item:${id}` : '';
}

/** One row per call, in call order: the group summary above is the only
 *  roll-up, so every row below it is the same kind of thing. */
function ToolActivityDetails({
  items,
  disclosureKey,
  mode,
}: {
  items: readonly TranscriptItem[];
  disclosureKey: string;
  mode: ToolActivityExpansion;
}) {
  const contentId = useId();
  return (
    <div className="tool-activity-details">
      {items.map((item, index) => {
        const key = activityItemKey(item, index);
        return (
          <ToolActivityItem
            key={key}
            item={item}
            disclosureKey={disclosureChildKey(disclosureKey, key)}
            defaultOpen={toolActivityCallExpands(item, mode)}
            contentId={`${contentId}-item-${index}`}
          />
        );
      })}
    </div>
  );
}

const TOOL_ACTIVITY_MARKDOWN_HINT = /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\n\s*\|[^\n]*\|\s*(?:\n|$)/;
const TOOL_ACTIVITY_MARKDOWN_MAX = 20_000;
const ToolMarkdownBody = lazy(preloadMarkdownBody);

function structuredKindLabel(kind: string): string {
  if (kind === 'questions') return TOOL_DETAIL_LABELS.questions;
  return kind === 'todos' ? TOOL_DETAIL_LABELS.todos : TOOL_DETAIL_LABELS.plan;
}

function toolActivityLooksMarkdown(text: string): boolean {
  return text.length <= TOOL_ACTIVITY_MARKDOWN_MAX && TOOL_ACTIVITY_MARKDOWN_HINT.test(text);
}

function ToolActivityRichBody({ text, fallbackClassName }: { text: string; fallbackClassName: string }) {
  return (
    <div className="markdown tool-activity-markdown">
      <Suspense fallback={<pre className={fallbackClassName}>{text}</pre>}>
        <ToolMarkdownBody text={text} copyControl={CopyControl} />
      </Suspense>
    </div>
  );
}

function ToolActivityBody({ text, className }: { text: string; className: string }) {
  if (!toolActivityLooksMarkdown(text)) return <pre className={className}>{text}</pre>;
  return <ToolActivityRichBody text={text} fallbackClassName={className} />;
}

type ToolActivityPresentation = ReturnType<typeof desktopToolActivityItemPresentation>;

/** What a closed row says about the outcome: nothing, unless it changed
 *  lines (the +/- chips) or went wrong (the failure). Counts and statuses
 *  ("424 lines", "13 matches", "background task") wait inside the row —
 *  on every row they buried the list (user: 열기 전이 너무 디테일). */
const MACHINE_ID = /\b([a-z]+)_\d{10,}_([0-9a-f]{4,})\b/g;

/** `job_1790959235138_a33acd` reads as `job a33acd`: the timestamp is noise,
 *  and the suffix is what tells two background tasks apart. */
function shortMachineId(text: string): string {
  return text.replace(MACHINE_ID, '$1 $2');
}

/** The closed row already carries this outcome as +/- chips. */
function rowShowsOutcome(presentation: ToolActivityPresentation): boolean {
  return (splitLineDeltaTokens(presentation.resultLabel) as DetailLinePart[]).some((part) => part.delta);
}

function ToolRowOutcome({ presentation }: { presentation: ToolActivityPresentation }) {
  if (!presentation.resultLabel) return null;
  if (presentation.tone !== 'neutral') {
    return <span className="tool-activity-item-result">{presentation.resultLabel}</span>;
  }
  const deltas = (splitLineDeltaTokens(presentation.resultLabel) as DetailLinePart[]).filter((part) => part.delta);
  if (!deltas.length) return null;
  return (
    <span className="tool-activity-item-result">
      {deltas.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one label string; the position is the identity.
        <em key={index} data-delta={part.delta}>
          {part.text}
        </em>
      ))}
    </span>
  );
}

function renderToolActivityHeader({
  presentation,
  open,
  onToggle,
  contentId,
  startedAt,
}: {
  presentation: ToolActivityPresentation;
  open: boolean;
  onToggle: () => void;
  contentId: string;
  startedAt: number;
}) {
  // The row is a plain container: the disclosure is a stretched sibling
  // button and the file link a separate button, so controls never nest.
  // Clicks on the row's text reach the container and toggle like before.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the stretched sibling button is the keyboard path; this click only widens the target.
    // biome-ignore lint/a11y/useKeyWithClickEvents: same as above.
    <div
      className="tool-header tool-activity-item-header"
      data-disclosure={presentation.hasDetails ? 'true' : 'false'}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={presentation.hasDetails ? onToggle : undefined}
    >
      {presentation.hasDetails && (
        <button
          type="button"
          className="tool-activity-item-toggle"
          aria-label={[presentation.verb, presentation.headerSubject].filter(Boolean).join(' ')}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        />
      )}
      <span
        className="tool-title tool-activity-item-title"
        title={[presentation.title, presentation.subject, presentation.resultLabel].filter(Boolean).join(' · ')}
      >
        <b>
          <TextShimmer text={presentation.verb} active={presentation.pending} />
        </b>
        {presentation.headerSubject &&
          !(open && presentation.hideSubjectWhenOpen) &&
          !(presentation.pending && !presentation.command) && (
            <small data-kind={presentation.subjectKind}>
              {presentation.subjectIsTarget ? (
                <LocalPathMention path={presentation.targetPath} line={presentation.targetLine}>
                  {presentation.headerSubject}
                </LocalPathMention>
              ) : (
                presentation.headerSubject
              )}
            </small>
          )}
      </span>
      <ToolRowOutcome presentation={presentation} />
      {presentation.pending && <ToolWorkingStatus startedAt={startedAt} spark />}
      {presentation.pending && (
        <span className="sr-only" role="status">
          {t('Running')}
        </span>
      )}
      {presentation.hasDetails && (
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRight size={16} />
        </span>
      )}
    </div>
  );
}

/** A command run: the command sits in its own framed box, highlighted as
 *  shell, and what it printed follows as plain terminal text below the box. */
function renderToolActivityTerminal(presentation: ToolActivityPresentation) {
  return (
    <section className="tool-activity-item-section tool-activity-terminal">
      <ToolPanel
        kind="command"
        copyValue={[presentation.command, presentation.outputText].filter(Boolean).join('\n\n')}
      >
        <span className="tool-terminal-prompt" aria-hidden="true">
          $
        </span>
        <ToolCommand command={presentation.command} />
      </ToolPanel>
      {presentation.outputText && (
        <pre className="tool-activity-item-output tool-terminal-output" data-scrollable>
          {presentation.outputText}
        </pre>
      )}
    </section>
  );
}

function renderToolActivityStructured(presentation: ToolActivityPresentation) {
  return (
    <section className="tool-activity-item-section">
      <span>{structuredKindLabel(presentation.structuredKind)}</span>
      <div className="tool-activity-structured-list">
        {presentation.structuredRows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: row text can repeat; the position within the list is the identity.
          <div className="tool-activity-structured-row" data-status={row.status} key={`${row.text}:${index}`}>
            <span className="tool-activity-structured-marker" aria-hidden="true">
              {toolActivityIsCompleted(row.status) ? '✓' : '○'}
            </span>
            {presentation.structuredKind === 'questions' ? (
              <span className="tool-activity-structured-question">
                <span className="tool-activity-structured-content">{row.text}</span>
                {row.answer && (
                  <span className="tool-activity-structured-answer">
                    <span>{TOOL_DETAIL_LABELS.answer}</span>
                    {row.answer}
                  </span>
                )}
              </span>
            ) : (
              <span className="tool-activity-structured-content">{row.text}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function renderToolActivityReplacement(presentation: ToolActivityPresentation) {
  const sides = [
    { kind: 'before', label: TOOL_DETAIL_LABELS.before, text: presentation.beforeText },
    { kind: 'after', label: TOOL_DETAIL_LABELS.after, text: presentation.afterText },
  ];
  return (
    <section className="tool-activity-item-section tool-activity-replacement">
      {sides.map((side) => (
        <ToolPanel
          className="tool-activity-replacement-block"
          kind={side.kind}
          label={side.label}
          copyValue={side.text}
          key={side.kind}
        >
          <ToolCode rows={toolCodeRowsPlain(side.text)} language={presentation.replacementLanguage} />
        </ToolPanel>
      ))}
    </section>
  );
}

/** A tool's own result: file rows, JSON, a rendered answer, or plain text. */
function renderToolActivityOutput(presentation: ToolActivityPresentation) {
  const className = 'tool-activity-item-section tool-activity-item-result-block';
  if (presentation.entries.length > 0) {
    return (
      <ToolPanel className={className} kind="files" copyValue={presentation.outputText}>
        <ToolFileList entries={presentation.entries} />
        {presentation.entryNotes.length > 0 && (
          <pre className="tool-activity-item-output tool-file-notes">{presentation.entryNotes.join('\n')}</pre>
        )}
      </ToolPanel>
    );
  }
  if (presentation.outputLanguage) {
    return (
      <ToolPanel className={className} kind="code" copyValue={presentation.outputText}>
        <ToolCode rows={toolCodeRowsPlain(presentation.outputText)} language={presentation.outputLanguage} />
      </ToolPanel>
    );
  }
  if (!presentation.outputLiteral && toolActivityLooksMarkdown(presentation.outputText)) {
    return (
      <ToolPanel className={className} bare copyValue={presentation.outputText}>
        <ToolActivityRichBody text={presentation.outputText} fallbackClassName="tool-activity-item-output" />
      </ToolPanel>
    );
  }
  return (
    <ToolPanel className={className} kind="text" copyValue={presentation.outputText}>
      <pre className="tool-activity-item-output">{presentation.outputText}</pre>
    </ToolPanel>
  );
}

function renderToolActivityFields(presentation: ToolActivityPresentation) {
  return (
    <section className="tool-activity-item-section">
      <span>{TOOL_DETAIL_LABELS.arguments}</span>
      <dl className="tool-activity-item-fields">
        {presentation.fields.map((field) => (
          <React.Fragment key={field.key}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

// Every detail section a tool item can carry: command output, structured rows,
// a preview, a before/after replacement, arguments, a diff, and plain output.
function renderToolActivityDetails(
  presentation: ToolActivityPresentation,
  contentId: string,
  onShowMore: (() => void) | null
) {
  return (
    <div className="tool-activity-item-body" id={contentId}>
      <ToolActivityPreview onShowMore={onShowMore}>
        {(presentation.metaText ||
          (presentation.tone === 'neutral' && presentation.resultLabel && !rowShowsOutcome(presentation)) ||
          (presentation.fieldsInline && presentation.fields.length > 0)) && (
          <p className="tool-activity-item-meta">
            {[
              presentation.metaText,
              presentation.tone === 'neutral' && !rowShowsOutcome(presentation) ? presentation.resultLabel : '',
              ...(presentation.fieldsInline ? presentation.fields.map((field) => `${field.label} ${field.value}`) : []),
            ]
              .filter(Boolean)
              .map(shortMachineId)
              .join(' · ')}
          </p>
        )}
        {presentation.targets.length > 0 && presentation.sections.length === 0 && (
          <section className="tool-activity-item-section">
            <span>{TOOL_DETAIL_LABELS.targets}</span>
            <ul className="tool-activity-targets">
              {presentation.targets.map((target, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: targets can repeat; the position within the list is the identity.
                <li key={`${target}:${index}`}>{target}</li>
              ))}
            </ul>
          </section>
        )}
        {presentation.structuredRows.length > 0 && renderToolActivityStructured(presentation)}
        {presentation.promptText && (
          <ToolPanel
            className="tool-activity-item-section"
            kind="prose"
            label={TOOL_DETAIL_LABELS.prompt}
            copyValue={presentation.promptText}
          >
            <ToolActivityBody text={presentation.promptText} className="tool-activity-item-prompt" />
          </ToolPanel>
        )}
        {presentation.sections.length > 0 && (
          <ToolPanel
            className="tool-activity-item-section tool-activity-item-result-block"
            kind="code"
            copyValue={presentation.sectionCopyText}
          >
            <ToolSections sections={presentation.sections} />
          </ToolPanel>
        )}
        {(presentation.beforeText || presentation.afterText) && renderToolActivityReplacement(presentation)}
        {presentation.fields.length > 0 && !presentation.fieldsInline && renderToolActivityFields(presentation)}
        {presentation.command && renderToolActivityTerminal(presentation)}
        {presentation.diffPatch && <CodeDiff patch={presentation.diffPatch} />}
        {presentation.outputText &&
          !presentation.command &&
          presentation.sections.length === 0 &&
          renderToolActivityOutput(presentation)}
      </ToolActivityPreview>
    </div>
  );
}

/** A call the expansion setting opened shows its first lines only; "Show
 *  more" (or opening it by hand) lifts the cap. */
function ToolActivityPreview({ onShowMore, children }: { onShowMore: (() => void) | null; children: ReactNode }) {
  const clamped = Boolean(onShowMore);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const frame = content?.parentElement;
    if (!clamped || !content || !frame) {
      setOverflowing(false);
      return;
    }
    const measure = () => setOverflowing(content.scrollHeight > frame.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [clamped]);
  return (
    <div className="tool-activity-item-body-inner">
      <div
        className="tool-activity-preview"
        data-clamped={clamped ? 'true' : 'false'}
        data-overflowing={clamped && overflowing ? 'true' : 'false'}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {clamped && overflowing && onShowMore && (
        <button
          type="button"
          className="tool-activity-preview-more"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onShowMore}
        >
          {t('Show more')}
        </button>
      )}
    </div>
  );
}

function ToolActivityItem({
  item,
  disclosureKey,
  defaultOpen,
  contentId,
}: {
  item: TranscriptItem;
  disclosureKey: string;
  defaultOpen: boolean;
  contentId: string;
}) {
  const [open, onToggle, chosen, keepOpen] = useRememberedDisclosure(disclosureKey, defaultOpen);
  const presentation = useMemo(() => desktopToolActivityItemPresentation(item), [item]);
  const panelOpen = open && presentation.hasDetails;
  const { rendered, expanded } = useToolActivityDisclosure(panelOpen);

  return (
    <article
      className={`tool-activity-item ${presentation.tone}`}
      data-open={open ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {renderToolActivityHeader({ presentation, open, onToggle, contentId, startedAt: toolItemStartedAt(item) })}
      {rendered && presentation.hasDetails && renderToolActivityDetails(presentation, contentId, chosen ? null : keepOpen)}
    </article>
  );
}

export function ToolCard({ item, disclosureScope = '' }: { item: TranscriptItem; disclosureScope?: string }) {
  const disclosureKey = toolDisclosureKey(item, disclosureScope);
  const [open, toggleOpen] = useRememberedDisclosure(disclosureKey);
  const contentId = useId();
  const done = toolItemDone(item);
  const startedAt = Number(item.startedAt || 0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (done || !startedAt) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [done, startedAt]);
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const denied = isHookApprovalDenialToolItem(item);
  const surface = formatToolSurface(item.name, item.args);
  const category = classifyToolCategory(item.name, surface.args);
  const rawResult = item.result ?? item.rawResult;
  const model = useMemo(
    () =>
      deriveToolCardModel({
        name: item.name,
        args: item.args,
        result: item.result,
        rawResult: item.rawResult,
        isError: item.isError,
        errorCount: item.errorCount,
        callErrorCount: item.callErrorCount,
        exitErrorCount: item.exitErrorCount,
        count: item.count,
        completedCount: done ? Math.max(1, Math.round(Number(item.count || 1))) : 0,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        aggregate: Boolean(item.aggregate),
        categories: item.categories,
        doneCategories: item.doneCategories,
        headerFinalized: item.headerFinalized,
        nowMs: nowTick,
      }) as ToolCardModel,
    [item, done, nowTick]
  );
  const hasResult = typeof rawResult === 'string' ? Boolean(rawResult.trim()) : rawResult != null;
  const hasDetails = Boolean(model.detailLine);
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const partialMutation = callFailedCount > 0 && typeof item.uiDiff === 'string' && Boolean(item.uiDiff.trim());
  const outcomeTone = deriveToolOutcomeTone({
    pending: model.pending,
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus: denied ? 'denied' : model.terminalStatus,
    partialMutation,
  });
  const failure = outcomeTone === 'error';
  const warning = outcomeTone === 'warning';
  const previousFailure = useRef(failure);
  const failureArrived = failure && !previousFailure.current;
  useEffect(() => {
    previousFailure.current = failure;
  }, [failure]);
  const errorCard = (failure || warning) && hasResult;
  const detailRowVisible = Boolean(model.detailLine) && open;
  return (
    <article
      className={`tool-card ${failure ? 'failed' : ''} ${warning ? 'warning' : ''} ${failureArrived ? 'failure-arrived' : ''} ${done ? 'settled' : ''}`}
      data-category={category}
      data-kind={errorCard ? 'tool-error-card' : undefined}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className="tool-header"
        disabled={!hasDetails}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={toggleOpen}
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? contentId : undefined}
      >
        <span className="tool-icon">{toolIcon(category)}</span>
        <span
          className="tool-title"
          title={[model.labelText, model.summaryText ? `(${model.summaryText})` : ''].filter(Boolean).join(' ')}
        >
          <b
            data-component={item.aggregate ? 'tool-count-summary' : 'tool-status-title'}
            data-active={!done ? 'true' : 'false'}
          >
            <TextShimmer text={model.labelText} active={!done} />
          </b>
        </span>
        {model.headerFailureText && (
          <span className={`tool-state ${warning ? 'warning' : 'failed'}`} role="status">
            {model.headerFailureText}
          </span>
        )}
        {!done && (
          <span className="sr-only" role="status">
            {t('Running')}
          </span>
        )}
        {hasDetails && (
          <span className="tool-chevron" aria-hidden="true">
            <ChevronRight size={16} />
          </span>
        )}
      </button>
      {detailRowVisible && (
        <div className="tool-detail-line" id={contentId} data-component="tool-collapsed-summary">
          <span className="tool-detail-text" data-placeholder={model.detailIsPlaceholder || undefined}>
            {(splitLineDeltaTokens(model.detailLine) as DetailLinePart[]).map((part, index) =>
              part.delta ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one detail line; the position is the identity.
                <em key={index} data-delta={part.delta}>
                  {part.text}
                </em>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one detail line; the position is the identity.
                <React.Fragment key={index}>{part.text}</React.Fragment>
              )
            )}
          </span>
        </div>
      )}
      <TranscriptArtifacts items={[item]} />
    </article>
  );
}

const TOOL_CATEGORY_ICONS: Record<string, React.ReactNode> = {
  Patch: <Code2 size={16} />,
  Read: <MxIcon name="open-file" size={16} />,
  Search: <MxIcon name="magnifying-glass" size={16} />,
  'Web Research': <Globe size={16} />,
  Shell: <MxIcon name="terminal" size={16} />,
  Git: <GitBranch size={16} />,
  Agent: <Bot size={16} />,
  Task: <MxIcon name="tasks" size={16} />,
  Memory: <Brain size={16} />,
  MCP: <Plug size={16} />,
  Skill: <Sparkles size={16} />,
  Load: <PackageOpen size={16} />,
  Setup: <Settings2 size={16} />,
  Browser: <AppWindow size={16} />,
  Computer: <Monitor size={16} />,
  Office: <FileSpreadsheet size={16} />,
  Media: <MxIcon name="photo" size={16} />,
  Tidy: <Brush size={16} />,
};

function toolIcon(category: unknown) {
  return TOOL_CATEGORY_ICONS[String(category)] ?? <Layers3 size={16} />;
}
