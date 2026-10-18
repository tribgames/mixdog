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
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { preloadMarkdownBody } from './markdown-body-loader';
import { LocalPathMention, openWebLinkInSystemBrowser, webLinkMenu } from './MarkdownLink';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuState,
} from './ScmContextMenu';
import { ToolComputerReadinessCard } from './transcript-computer-card';
import { usePersistedThumbnail } from './persisted-thumbnail';
import { ToolVisualizeCards } from './transcript-visualize-card';
import { rememberVisualizeTabTitles, visualizeCallTabTitle } from './visualize-card-model';
import { useToolOutcomeUnknown } from './connection-link-store';
import { MxIcon } from './MxIcon';
import { formatElapsed } from './text-format';
import { useClock } from './use-clock';
import { CodeDiff } from './transcript-diff';
import { TurnChangesContext } from './TurnChangesCard';
import { requestSessionDiffFile } from './session-diff-focus';
import { capPatchLines } from './renderer-logic.mjs';
import { CopyControl } from './transcript-primitives';
import { FullToolOutputButton, useFullToolOutput } from './tool-full-output';
import { TranscriptArtifacts } from './transcript-artifacts-ui';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { useBrowserPageIdentity } from './browser-page-identity';
import { useLoadableFavicon } from './link-kind-icon';
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
  desktopToolActivityCategory,
  desktopToolActivitySummary,
  desktopToolActivityItemPresentation,
  diffTargetPath,
  flattenedToolActivityItems,
  isHookApprovalDenialToolItem,
  shortMachineId,
  TOOL_DETAIL_LABELS,
  toolActivityIsCompleted,
  toolItemDone,
  toolItemHasDiff,
  type ToolActivityBrowserPage,
  type ToolCardModel,
} from './transcript-tool-model';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatToolSurface } from '../../../../src/runtime/shared/tool-surface.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { formatElapsed as formatCardElapsed } from '../../../../src/runtime/shared/time-format.mjs';
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
  /** The turn the group belongs to; scopes what is asked once per task. */
  turnKey?: string;
}

/** The live projection rebuilds a group's items array on every tick from the
 *  same item objects; element identity is what decides a re-render. */
function sameToolActivityGroupProps(previous: ToolActivityGroupProps, next: ToolActivityGroupProps): boolean {
  if ((previous.disclosureScope ?? '') !== (next.disclosureScope ?? '')) return false;
  if ((previous.turnKey ?? '') !== (next.turnKey ?? '')) return false;
  if (previous.items === next.items) return true;
  return (
    previous.items.length === next.items.length && previous.items.every((item, index) => item === next.items[index])
  );
}

/** When a tool call started (epoch ms). Transcript items carry their start as
 *  `at`; `startedAt` wins where a projection provides one. */
function toolItemStartedAt(item: { startedAt?: unknown; at?: unknown }): number {
  const value = Number(item.startedAt || item.at || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Elapsed (from 5s) while the work is pending, so the one-second tick stops
 *  with it. */
function ToolWorkingStatus({ startedAt }: { startedAt: number }) {
  const now = useClock(startedAt > 0);
  const elapsedMs = startedAt ? now - startedAt : 0;
  if (elapsedMs < 5_000) return null;
  return (
    <span className="tool-working">
      <span className="tool-working-elapsed">{formatElapsed(elapsedMs)}</span>
    </span>
  );
}

/** Live elapsed text since `startedAt` (from `minMs`), ticking on its own so
 *  only this leaf re-renders each second. */
const Elapsed = React.memo(function Elapsed({
  startedAt,
  prefix = '',
  minMs = 1_000,
}: {
  startedAt: number;
  prefix?: string;
  minMs?: number;
}) {
  const elapsedMs = Math.max(0, useClock(true) - startedAt);
  return elapsedMs >= minMs ? (
    <>
      {prefix}
      {formatCardElapsed(elapsedMs) as string}
    </>
  ) : null;
});

type LineCounts = { additions: number; deletions: number };

/** Lines a change adds and removes as one split pill ("+12 −3"). Both halves
 *  show once either is non-zero, so a row of pills lines up; nothing changed
 *  draws nothing. */
function ToolDiffCounts({ counts }: { counts: LineCounts | null }) {
  if (!counts || (counts.additions === 0 && counts.deletions === 0)) return null;
  return (
    <span
      className="tool-diff-counts"
      role="img"
      aria-label={t('Lines changed: +{{additions}} −{{deletions}}', counts)}
    >
      <i aria-hidden="true">+{counts.additions}</i>
      <em aria-hidden="true">−{counts.deletions}</em>
    </span>
  );
}

/** The lines every file change of a group adds and removes. */
function groupLineCounts(calls: readonly TranscriptItem[]): LineCounts {
  const total: LineCounts = { additions: 0, deletions: 0 };
  for (const item of calls) {
    if (desktopToolActivityCategory(item.name, item.args) !== 'Patch') continue;
    const counts = desktopToolActivityItemPresentation(item).diffCounts;
    if (!counts) continue;
    total.additions += counts.additions;
    total.deletions += counts.deletions;
  }
  return total;
}

/** Memoized: every TranscriptList render re-invokes renderRow for each row. */
export const ToolActivityGroup = React.memo(function ToolActivityGroup({
  items,
  disclosureScope = '',
  turnKey = '',
}: ToolActivityGroupProps) {
  const { mode, key: viewKey } = useToolActivityView();
  const disclosureKey = toolActivityDisclosureKey(items, disclosureScope, viewKey);
  const calls = useMemo(() => flattenedToolActivityItems(items), [items]);
  // Before the rows render: they name a visualize tab by the title it opened with.
  useMemo(() => rememberVisualizeTabTitles(disclosureScope, items), [disclosureScope, items]);
  const [open, toggleOpen] = useRememberedDisclosure(
    disclosureKey,
    calls.some((item) => toolActivityCallExpands(item, mode))
  );
  const { rendered, expanded } = useToolActivityDisclosure(open);
  const contentId = useId();
  const outcomeUnknown = useToolOutcomeUnknown();
  const pending = items.some((item) => !toolItemDone(item) && !outcomeUnknown(item.id));
  const summary = useMemo(() => desktopToolActivitySummary(items), [items]);
  // Settled changes count as soon as they land; a call still running (or
  // failed) has no counts yet, and the running readout stays its own.
  const lineCounts = useMemo(() => groupLineCounts(calls), [calls]);
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
        <span className="tool-title tool-activity-title" title={label}>
          <b>{label}</b>
        </span>
        <ToolDiffCounts counts={lineCounts} />
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
              <ToolActivityDetails items={calls} disclosureKey={disclosureKey} mode={mode} scope={disclosureScope} />
            </div>
          </div>
        </div>
      )}
      {browserPage && <ToolBrowserPageCard page={browserPage} sessionId={disclosureScope} />}
      <ToolVisualizeCards items={items} sessionId={disclosureScope} />
      <ToolComputerReadinessCard items={items} taskKey={`${disclosureScope}|${turnKey}`} />
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
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  // What the in-app browser saw there: a screenshot leads the card; without
  // one the site icon and title stand in; without either, globe and address.
  const identity = useBrowserPageIdentity(page.url, { preview: true });
  const [faviconSrc, onFaviconError] = useLoadableFavicon(identity?.favicon);
  // The page's screenshot is kept per session + address, so the card still has
  // its picture after a restart, before (or without) the browser seeing it again.
  const thumbnail = usePersistedThumbnail(sessionId, `browser|${page.url}`, identity?.thumbnail || undefined);
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable() }) !== 'pane') return null;
  const favicon = faviconSrc ? (
    <img
      className="transcript-browser-page-favicon"
      src={faviconSrc}
      alt=""
      draggable={false}
      onError={onFaviconError}
    />
  ) : null;
  let body: ReactNode;
  if (thumbnail) {
    body = (
      <>
        <span className="transcript-browser-page-thumb" aria-hidden="true">
          <img src={thumbnail} alt="" draggable={false} />
        </span>
        <span className="transcript-browser-page-copy" title={page.url}>
          <span className="transcript-browser-page-site">
            {favicon ?? <Globe size={14} aria-hidden="true" />}
            <span>{page.host}</span>
          </span>
          <b>{identity?.title || page.host}</b>
          {page.path && <small>{page.path}</small>}
        </span>
      </>
    );
  } else {
    body = (
      <>
        <span className="transcript-browser-page-icon" aria-hidden="true">
          {favicon ?? <Globe size={16} />}
        </span>
        <span className="transcript-browser-page-copy" title={page.url}>
          <b>{identity?.title || page.host}</b>
          <small>
            {identity?.title
              ? `${page.host}${page.path}`
              : [page.path, t('Opened in browser')].filter(Boolean).join(' · ')}
          </small>
        </span>
      </>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper only catches context-menu requests (right-click / menu key) bubbling from its child controls.
    <div
      className={`transcript-browser-page${thumbnail ? ' has-thumbnail' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(webLinkMenu(sessionId, page.url, pointerMenuPoint(event)));
      }}
      onKeyDown={(event) => {
        if (!isContextMenuKey(event)) return;
        event.preventDefault();
        setMenu(webLinkMenu(sessionId, page.url, elementMenuPoint(event.currentTarget)));
      }}
    >
      {menu && <ScmContextMenu state={menu} onClose={() => setMenu(null)} />}
      {body}
      <button
        type="button"
        className="transcript-browser-page-open"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) openWebLinkInSystemBrowser(sessionId, page.url);
          else requestBrowserPage(sessionId, page.url);
        }}
        // Windows middle-click autoscroll swallows auxclick unless the press is cancelled.
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          openWebLinkInSystemBrowser(sessionId, page.url);
        }}
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
  scope,
}: {
  items: readonly TranscriptItem[];
  disclosureKey: string;
  mode: ToolActivityExpansion;
  scope: string;
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
            scope={scope}
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

/** The closed row already carries this outcome as +/- chips. */
function rowShowsOutcome(presentation: ToolActivityPresentation): boolean {
  return (splitLineDeltaTokens(presentation.resultLabel) as DetailLinePart[]).some((part) => part.delta);
}

/** The facts an open call owes the reader ("28 files · sorted natural", "37
 *  lines", a background task's status). They ride in the open row's header
 *  band beside the title, as a table header carries its count, instead of a
 *  loose second line between the band and the body. */
export function toolActivityMetaLine(presentation: ToolActivityPresentation): string {
  const verb = presentation.verb.trim().toLocaleLowerCase();
  // The row already opens with its verb: a part that only repeats it ("Run ·
  // Running") adds nothing.
  const repeatsVerb = (part: string) => {
    const text = part.toLocaleLowerCase();
    return Boolean(verb) && (text === verb || text.startsWith(`${verb} `));
  };
  // A non-neutral outcome carries the meta's status and id itself
  // (toolActivityOutcomeText); the meta line keeps only what is left.
  const outcomeShown = presentation.tone !== 'neutral' && Boolean(presentation.resultLabel);
  const parts = [
    ...(outcomeShown ? [] : presentation.metaText.split(' · ').filter((part) => !repeatsVerb(part))),
    presentation.tone === 'neutral' && !rowShowsOutcome(presentation) ? presentation.resultLabel : '',
    ...(presentation.fieldsInline ? presentation.fields.map((field) => `${field.label} ${field.value}`) : []),
  ]
    .filter(Boolean)
    .map(shortMachineId);
  // The subject already says what a part repeats ("대기 · 971b88" + "971b88").
  const subject = shortMachineId(presentation.subject).toLocaleLowerCase();
  const inSubject = new Set([subject, ...subject.split(' · ')]);
  return [...new Set(parts)].filter((part) => !inSubject.has(part.toLocaleLowerCase())).join(' · ');
}

/** A failed row reads outcome first, then the id: "실패 · 종료 1 · 711cd8". */
export function toolActivityOutcomeText(presentation: ToolActivityPresentation): string {
  const outcome = shortMachineId(presentation.resultLabel);
  const verb = presentation.verb.trim().toLocaleLowerCase();
  const subject = shortMachineId(presentation.subject).toLocaleLowerCase();
  const skip = new Set([verb, subject, ...subject.split(' · '), ...outcome.toLocaleLowerCase().split(' · ')]);
  const rest = presentation.metaText
    .split(' · ')
    .map(shortMachineId)
    .filter((part) => part && !skip.has(part.toLocaleLowerCase()));
  return [...new Set([outcome, ...rest])].join(' · ');
}

export function ToolRowOutcome({ presentation }: { presentation: ToolActivityPresentation }) {
  // A row that cannot open has nowhere to keep its status and id: they ride
  // here, beside the verb ("실행 · 완료 · 971b88").
  if (!presentation.hasDetails && presentation.tone === 'neutral' && presentation.metaText) {
    const meta = toolActivityMetaLine({ ...presentation, resultLabel: '', fields: [], fieldsInline: false });
    if (meta) return <span className="tool-activity-item-result">{meta}</span>;
  }
  if (!presentation.resultLabel) return null;
  // A file change says its lines once, in the pill beside its name.
  if (presentation.diffCounts && presentation.tone === 'neutral') return null;
  // A failed command's row stays one short line: its red verb already says it
  // failed, so the row adds only the exit ("종료 코드 2"); the error itself
  // (often a long interpreter path) is in the output below.
  if (presentation.command && presentation.tone === 'error') {
    return <span className="tool-activity-item-result">{presentation.outputNote || t('Failed')}</span>;
  }
  if (presentation.tone !== 'neutral') {
    const text = toolActivityOutcomeText(presentation);
    const reason = presentation.outcomeReason;
    const at = reason ? text.indexOf(reason) : -1;
    // The status, exit and id stay whole; only the reason gives way.
    if (at < 0) return <span className="tool-activity-item-result">{text}</span>;
    return (
      <span className="tool-activity-item-result" data-reason="true">
        <span className="tool-activity-item-chips">{text.slice(0, at)}</span>
        <span className="tool-activity-item-reason">{reason}</span>
        <span className="tool-activity-item-chips">{text.slice(at + reason.length)}</span>
      </span>
    );
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
  const metaLine = open && presentation.hasDetails ? toolActivityMetaLine(presentation) : '';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the stretched sibling button is the keyboard path; this click only widens the target.
    // biome-ignore lint/a11y/useKeyWithClickEvents: same as above.
    <div
      className="tool-header tool-activity-item-header"
      title={[presentation.title, presentation.subject, presentation.resultLabel, metaLine].filter(Boolean).join(' · ')}
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
      <span className="tool-title tool-activity-item-title">
        <b>{presentation.verb}</b>
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
      <ToolDiffCounts counts={presentation.diffCounts} />
      {metaLine && <span className="tool-activity-item-meta">{metaLine}</span>}
      <ToolRowOutcome presentation={presentation} />
      {presentation.pending && <ToolWorkingStatus startedAt={startedAt} />}
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

const PREVIEW_OUTPUT_LINES = 5;
// Every box a preview may cut short: plates and plain output. A command is
// always shown whole.
const PREVIEW_CUT_SELECTOR = '.tool-panel:not([data-kind="command"]) > .tool-panel-body, .tool-activity-item-output';

type ToolActivityPreviewMode = 'lines' | 'height';

/** A preview cuts a command run or plain text output by lines; anything else
 *  (files, code, diffs, rendered answers) by height. */
function toolActivityPreviewMode(presentation: ToolActivityPresentation): ToolActivityPreviewMode {
  const plainOutput =
    !presentation.entries.length &&
    !presentation.outputLanguage &&
    (presentation.outputLiteral || !toolActivityLooksMarkdown(presentation.outputText));
  const onlyText =
    !presentation.diffPatch &&
    !presentation.sections.length &&
    !presentation.structuredRows.length &&
    !presentation.promptText &&
    !presentation.beforeText &&
    !presentation.afterText &&
    !presentation.targets.length &&
    (presentation.fieldsInline || !presentation.fields.length);
  return onlyText && (presentation.command || plainOutput) ? 'lines' : 'height';
}

/** The first lines of an output and how many it hides. A single hidden line
 *  is shown instead of being counted. */
function previewOutputLines(text: string): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_OUTPUT_LINES + 1) return { text, hidden: 0 };
  return { text: lines.slice(0, PREVIEW_OUTPUT_LINES).join('\n'), hidden: lines.length - PREVIEW_OUTPUT_LINES };
}

// The height clamp shows about six lines (6 × line + 16px); twice that always
// overfills it, so what is cut here is never visible.
const PREVIEW_HEIGHT_LINES = 12;

/** The first `max` lines of a text without splitting all of it. */
function capLines(text: string, max = PREVIEW_HEIGHT_LINES): { text: string; cut: boolean } {
  let end = -1;
  for (let line = 0; line < max; line++) {
    end = text.indexOf('\n', end + 1);
    if (end < 0) return { text, cut: false };
  }
  return { text: text.slice(0, end), cut: true };
}

/** A height-clamped preview's input, bounded to what the clamp can show. */
function capPresentation(presentation: ToolActivityPresentation): {
  view: ToolActivityPresentation;
  cut: boolean;
} {
  let cut = false;
  const lines = (text: string) => {
    const capped = capLines(text);
    cut ||= capped.cut;
    return capped.text;
  };
  const rowsBudget = <T,>(list: readonly T[]) => {
    cut ||= list.length > PREVIEW_HEIGHT_LINES;
    return list.slice(0, PREVIEW_HEIGHT_LINES);
  };
  let budget = PREVIEW_HEIGHT_LINES;
  const sections: typeof presentation.sections = [];
  for (const section of presentation.sections) {
    if (budget <= 0) {
      cut = true;
      break;
    }
    const rows = section.rows.slice(0, budget);
    cut ||= rows.length < section.rows.length;
    budget -= rows.length;
    sections.push(rows.length < section.rows.length ? { ...section, rows } : section);
  }
  const view = {
    ...presentation,
    outputText: lines(presentation.outputText),
    promptText: lines(presentation.promptText),
    beforeText: lines(presentation.beforeText),
    afterText: lines(presentation.afterText),
    diffPatch: presentation.diffPatch
      ? (() => {
          const capped = capPatchLines(presentation.diffPatch, PREVIEW_HEIGHT_LINES);
          cut ||= capped.cut;
          return capped.text;
        })()
      : presentation.diffPatch,
    entries: rowsBudget(presentation.entries),
    structuredRows: rowsBudget(presentation.structuredRows),
    sections,
  };
  return { view, cut };
}

/** A command run: the command sits in its own framed box, highlighted as
 *  shell, and what it printed follows as plain terminal text below the box. */
function renderToolActivityTerminal(
  presentation: ToolActivityPresentation,
  outputText = presentation.outputText,
  full = presentation
) {
  return (
    <section className="tool-activity-item-section tool-activity-terminal">
      <ToolPanel kind="command" copyValue={[full.command, full.outputText].filter(Boolean).join('\n\n')}>
        <span className="tool-terminal-prompt" aria-hidden="true">
          $
        </span>
        <ToolCommand command={presentation.command} />
      </ToolPanel>
      {outputText && (
        <pre className="tool-activity-item-output tool-terminal-output" data-scrollable>
          {outputText}
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

function renderToolActivityReplacement(presentation: ToolActivityPresentation, full = presentation) {
  const sides = [
    { kind: 'before', label: TOOL_DETAIL_LABELS.before, text: presentation.beforeText, copy: full.beforeText },
    { kind: 'after', label: TOOL_DETAIL_LABELS.after, text: presentation.afterText, copy: full.afterText },
  ];
  return (
    <section className="tool-activity-item-section tool-activity-replacement">
      {sides.map((side) => (
        <ToolPanel
          className="tool-activity-replacement-block"
          kind={side.kind}
          label={side.label}
          copyValue={side.copy}
          key={side.kind}
        >
          <ToolCode rows={toolCodeRowsPlain(side.text)} language={presentation.replacementLanguage} />
        </ToolPanel>
      ))}
    </section>
  );
}

/** A tool's own result: file rows, JSON, a rendered answer, or plain text. */
function renderToolActivityOutput(
  presentation: ToolActivityPresentation,
  outputText = presentation.outputText,
  full = presentation
) {
  const className = 'tool-activity-item-section tool-activity-item-result-block';
  if (presentation.entries.length > 0) {
    return (
      <ToolPanel className={className} kind="files" copyValue={full.outputText}>
        <ToolFileList entries={presentation.entries} />
        {presentation.entryNotes.length > 0 && (
          <pre className="tool-activity-item-output tool-file-notes">{presentation.entryNotes.join('\n')}</pre>
        )}
      </ToolPanel>
    );
  }
  if (presentation.outputLanguage) {
    return (
      <ToolPanel className={className} kind="code" copyValue={full.outputText}>
        <ToolCode rows={toolCodeRowsPlain(presentation.outputText)} language={presentation.outputLanguage} />
      </ToolPanel>
    );
  }
  if (!presentation.outputLiteral && toolActivityLooksMarkdown(full.outputText)) {
    return (
      <ToolPanel className={className} bare copyValue={full.outputText}>
        <ToolActivityRichBody text={presentation.outputText} fallbackClassName="tool-activity-item-output" />
      </ToolPanel>
    );
  }
  return (
    <ToolPanel className={className} kind="text" copyValue={full.outputText}>
      <pre className="tool-activity-item-output">{outputText}</pre>
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

/** A file change: its full path on one quiet line (copy at the far right; the
 *  path opens the side diff pane where there is one), then the diff in its
 *  own outlined frame that scrolls under the fixed path line. */
function renderToolActivityDiff(patch: string, full: ToolActivityPresentation, onOpenDiff: (() => void) | null) {
  const path = full.targetPath || diffTargetPath(full.diffPatch);
  return (
    <section className="tool-activity-item-section tool-diff-block">
      <div className="tool-diff-path">
        {onOpenDiff ? (
          <button type="button" className="tool-diff-path-link" title={t('View changes')} onClick={onOpenDiff}>
            {path}
          </button>
        ) : (
          <span className="tool-diff-path-text">{path}</span>
        )}
        <CopyControl
          value={full.diffPatch}
          label="Copy diff for {{value0}}"
          labelOptions={{ value0: path }}
          className="tool-detail-copy"
        />
      </div>
      <div className="tool-diff-frame">
        <CodeDiff patch={patch} target={full.targetPath} />
      </div>
    </section>
  );
}

// Every detail section a tool item can carry: command output, structured rows,
// a preview, a before/after replacement, arguments, a diff, and plain output.
function renderToolActivityDetails(
  full: ToolActivityPresentation,
  contentId: string,
  onShowMore: (() => void) | null,
  onOpenDiff: (() => void) | null = null
) {
  const mode = onShowMore ? toolActivityPreviewMode(full) : null;
  const capped = mode === 'height' ? capPresentation(full) : null;
  const presentation = capped ? capped.view : full;
  const output = mode === 'lines' ? previewOutputLines(full.outputText) : { text: presentation.outputText, hidden: 0 };
  return (
    <div className="tool-activity-item-body" id={contentId}>
      <ToolActivityPreview
        mode={mode}
        hiddenLines={output.hidden}
        truncated={Boolean(capped?.cut)}
        onShowMore={onShowMore}
      >
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
            copyValue={full.promptText}
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
        {(presentation.beforeText || presentation.afterText) && renderToolActivityReplacement(presentation, full)}
        {presentation.fields.length > 0 && !presentation.fieldsInline && renderToolActivityFields(presentation)}
        {presentation.command && renderToolActivityTerminal(presentation, output.text, full)}
        {presentation.outputNote && !(presentation.command && presentation.tone === 'error') && (
          // A failed command's exit already stands on its row.
          <p className="tool-activity-item-note">{presentation.outputNote}</p>
        )}
        {presentation.diffPatch && renderToolActivityDiff(presentation.diffPatch, full, onOpenDiff)}
        {presentation.outputText &&
          !presentation.command &&
          presentation.sections.length === 0 &&
          renderToolActivityOutput(presentation, output.text, full)}
      </ToolActivityPreview>
    </div>
  );
}

/** A call the expansion setting opened shows a preview: a command whole and
 *  five lines of its output, or a capped height for anything else. A
 *  quiet "… +N lines" note under it lifts the cap, as does opening by hand. */
function ToolActivityPreview({
  mode,
  hiddenLines,
  truncated,
  onShowMore,
  children,
}: {
  mode: ToolActivityPreviewMode | null;
  hiddenLines: number;
  truncated: boolean;
  onShowMore: (() => void) | null;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = frame?.firstElementChild;
    if (!mode || !frame || !content) {
      setClipped(false);
      return;
    }
    // Each box the preview actually cuts is marked, so only it fades out.
    // All geometry is read first, then attributes are written, and only
    // where the value changed, so no read forces a layout the writes dirtied.
    const measure = () => {
      const elements = [...frame.querySelectorAll(PREVIEW_CUT_SELECTOR)];
      const cuts = elements.map((element) => element.scrollHeight > element.clientHeight + 1);
      elements.forEach((element, index) => {
        if (element.hasAttribute('data-preview-cut') !== cuts[index]) {
          element.toggleAttribute('data-preview-cut', cuts[index]);
        }
      });
      setClipped(cuts.includes(true));
    };
    if (typeof ResizeObserver !== 'function') {
      measure();
      return;
    }
    // Its first delivery lands before paint, so it is the initial measure.
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    return () => observer.disconnect();
  }, [mode]);
  const more = Boolean(mode && onShowMore && (hiddenLines > 0 || truncated || clipped));
  return (
    <div className="tool-activity-item-body-inner">
      <div className="tool-activity-preview" data-clamped={mode ?? 'false'} ref={frameRef}>
        <div>{children}</div>
      </div>
      {more && onShowMore && (
        <button
          type="button"
          className="tool-activity-preview-more"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onShowMore}
        >
          {hiddenLines > 0 ? t('… +{{lines}} lines', { lines: hiddenLines }) : t('… Show more')}
        </button>
      )}
    </div>
  );
}

function ToolActivityItem({
  item: shownItem,
  disclosureKey,
  defaultOpen,
  contentId,
  scope,
}: {
  item: TranscriptItem;
  disclosureKey: string;
  defaultOpen: boolean;
  contentId: string;
  scope: string;
}) {
  const [open, onToggle, chosen, keepOpen] = useRememberedDisclosure(disclosureKey, defaultOpen);
  const fullOutput = useFullToolOutput(scope, shownItem, open);
  const item = fullOutput.item;
  const outcomeUnknown = useToolOutcomeUnknown()(item.id);
  const visualizeTabTitle = visualizeCallTabTitle(scope, item);
  const presentation = useMemo(() => {
    const base = desktopToolActivityItemPresentation(item, undefined, { visualizeTabTitle });
    // A server window lost this call's result with its link: say so instead of
    // running forever. It is never run again.
    return outcomeUnknown && base.pending
      ? { ...base, pending: false, tone: 'failed', resultLabel: t('Outcome unknown'), outcomeReason: '' }
      : base;
  }, [item, outcomeUnknown, visualizeTabTitle]);
  // A settled file change opens in place; its path line also opens the side
  // diff pane on that file (with the way back to the list), where a session
  // has that pane.
  const turnChanges = useContext(TurnChangesContext);
  const diffPath = presentation.pending
    ? ''
    : presentation.diffPatch
      ? diffTargetPath(presentation.diffPatch)
      : presentation.diffDigestPath;
  const openDiff =
    diffPath && turnChanges?.sessionId && turnChanges.onOpenSessionDiff
      ? () => {
          requestSessionDiffFile(turnChanges.sessionId, diffPath);
          turnChanges.onOpenSessionDiff?.();
        }
      : null;
  const panelOpen = open && presentation.hasDetails;
  const { rendered, expanded } = useToolActivityDisclosure(panelOpen);

  return (
    <article
      className={`tool-activity-item ${presentation.tone}`}
      data-open={open ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {renderToolActivityHeader({ presentation, open, onToggle, contentId, startedAt: toolItemStartedAt(item) })}
      {rendered &&
        presentation.hasDetails &&
        renderToolActivityDetails(presentation, contentId, chosen ? null : keepOpen, openDiff)}
      {rendered && presentation.hasDetails && <FullToolOutputButton output={fullOutput} />}
    </article>
  );
}

export function ToolCard({ item, disclosureScope = '' }: { item: TranscriptItem; disclosureScope?: string }) {
  const disclosureKey = toolDisclosureKey(item, disclosureScope);
  const [open, toggleOpen] = useRememberedDisclosure(disclosureKey);
  const contentId = useId();
  const done = toolItemDone(item);
  const startedAt = Number(item.startedAt || 0);
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
        // A pending card is derived at zero elapsed ("Running"); the ticking
        // `<Elapsed>` leaf appends the live time, so the card never re-renders
        // per second.
        nowMs: done ? undefined : startedAt || undefined,
      }) as ToolCardModel,
    [item, done, startedAt]
  );
  const hasResult = typeof rawResult === 'string' ? Boolean(rawResult.trim()) : rawResult != null;
  const hasDetails = Boolean(model.detailLine);
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const partialMutation = callFailedCount > 0 && toolItemHasDiff(item);
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
            {model.labelText}
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
            {model.detailIsPlaceholder && !done && startedAt > 0 && <Elapsed startedAt={startedAt} prefix=" · " />}
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
