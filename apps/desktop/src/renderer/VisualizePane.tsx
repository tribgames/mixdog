// The pane dock's visualize view: the agent `visualize` tool's tabs for one
// session. Main owns the tabs; this view draws the active one and reports the
// user's tab picks and closes. Capture finds the tab body by its data
// attributes, so they name the session and tab.
import { Eye, ListTree, MessageSquarePlus, SlidersHorizontal, Wifi, WifiOff, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DesktopApi } from '../shared/contract';
import { type VisualizePaneSource, type VisualizePaneView, visualizeProblemLocation } from '../shared/visualize';
import { withVisualizeFeedbackScript } from '../shared/visualize-feedback';
import { remotePageGate } from '../shared/visualize-scripts';
import { t } from './i18n';
import { visualizeCommentKind } from '../shared/visualize-comment-kinds';
import { useVisualizeFeedbackBridge, VisualizeCommentHints, VisualizeCommentLayer } from './VisualizeFeedback';
import { startElementPin, useVisualizeInspection, VisualizeElements } from './VisualizeElements';
import { VisualizeTweaksDrawer } from './VisualizeTweaks';
import { useVisualizeTweaksRevision, visualizeTabHasTweaks } from './visualize-tweaks-store';
import { loadSandboxedPage } from './sandboxed-page-preview';
import { DockHeaderRow } from './pane-dock-chrome';
import { InlinePaneContent } from './VisualizeInline';
import { useVisualizePanelExtras } from './VisualizePanelExtras';
import { VisualizeSource } from './VisualizeSource';
import { visualizePaneHasSource } from './visualize-source';
import { remoteInlinePageSource } from './visualize-inline-remote';
import {
  activateVisualizeTab,
  allowVisualizeReveal,
  allowVisualizeScripts,
  closeVisualizeTab,
  setVisualizeNetwork,
  useVisualizeScriptsAllowed,
  markVisualizePanelHidden,
  markVisualizePanelShown,
  reportVisualizeRender,
  useVisualizeState,
  visualizeHeaderActions,
  visualizePanesStacked,
  visualizeTabTooltip,
} from './visualize-store';
import './visualize.css';

function PaneContent({ pane }: { pane: VisualizePaneView }) {
  if (pane.kind === 'html') {
    // A project page from the tokenized loopback page server: its own origin,
    // never the app's, and no top-level navigation or popups.
    return (
      <iframe
        src={pane.url}
        title={pane.label}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        referrerPolicy="no-referrer"
      />
    );
  }
  // PDFs and converted Office documents use Chromium's built-in viewer,
  // which a sandboxed frame would refuse.
  if (pane.kind === 'pdf' || pane.kind === 'document') return <iframe src={pane.url} title={pane.label} />;
  if (pane.kind === 'image') return <img src={pane.url} alt={pane.label} />;
  if (pane.kind === 'audio') {
    // biome-ignore lint/a11y/useMediaCaption: agent-produced media carries no caption track.
    return <audio src={pane.url} controls />;
  }
  // biome-ignore lint/a11y/useMediaCaption: agent-produced media carries no caption track.
  return <video src={pane.url} controls />;
}

/** A pane on a paired remote client: the host's pane URLs name its loopback
 *  servers, so the content arrives over the relay instead (blob: URL, or a
 *  self-contained page in an opaque-origin frame). Remounted on each
 *  revision, so a file change on the host re-fetches it. Annotation marks
 *  exist only in the desktop window and are never drawn here. */
function RemotePaneContent({
  pane,
  sessionId,
  tabId,
  index,
  load,
  commenting,
}: {
  pane: VisualizePaneView;
  sessionId: string;
  tabId: string;
  index: number;
  load: NonNullable<DesktopApi['visualizePaneSource']>;
  /** Comment mode is on: a page that is not running yet offers Run. */
  commenting: boolean;
}) {
  const [source, setSource] = useState<VisualizePaneSource | null>(null);
  const [error, setError] = useState('');
  // Inline content rides the tab state; the pane remounts per revision.
  const inline = useRef(pane.inline);
  useEffect(() => {
    let alive = true;
    let url = '';
    (inline.current ? remoteInlinePageSource(inline.current) : load(sessionId, tabId, index)).then(
      (next) => {
        url = next.url ?? '';
        if (!alive) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setSource(next);
      },
      (reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      }
    );
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [load, sessionId, tabId, index]);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const srcdoc = source?.srcdoc;
  // A page the agent wrote first renders without scripts; only the user's tap
  // on "Run" (remembered for this tab on this device) lets them execute.
  const runAllowed = useVisualizeScriptsAllowed(sessionId, tabId);
  const gate = srcdoc !== undefined ? remotePageGate(srcdoc, runAllowed, commenting) : null;
  const gated = gate !== null && !gate.runScripts;
  // The feedback page script (Comment pins, `data-choice` picks) rides inside
  // the page: nothing on this client can reach into the opaque frame.
  useEffect(
    () =>
      frame && srcdoc !== undefined && !gated
        ? loadSandboxedPage(frame, withVisualizeFeedbackScript(srcdoc))
        : undefined,
    [frame, srcdoc, gated]
  );
  if (error && pane.inline) {
    // The interactive page could not be built here: the static render stands in.
    return (
      <div className="visualize-script-pane">
        <div className="visualize-script-gate" role="status">
          {t('The interactive view is unavailable here; showing a static render.')}
        </div>
        <InlinePaneContent pane={{ ...pane, kind: 'inline' }} />
      </div>
    );
  }
  if (error) return <div className="visualize-empty">{error}</div>;
  if (!source) return <div className="visualize-empty">{t('Loading…')}</div>;
  if (srcdoc !== undefined && gate) {
    if (gated) {
      // Fails closed: no `allow-scripts` at all (and no meta refresh to
      // follow) until the user taps Run, whatever detection found; markup
      // and styles only, in an opaque origin.
      return (
        <div className="visualize-script-pane">
          {gate.prompt ? (
            <div className="visualize-script-gate" role="status">
              <span>
                {gate.prompt === 'comments' ? t('Comments need this page to run.') : t('This page runs scripts.')}
              </span>
              <button type="button" onClick={(event) => allowVisualizeScripts(sessionId, tabId, event.nativeEvent)}>
                {t('Run')}
              </button>
            </div>
          ) : null}
          {pane.inline?.kind === 'chart' ? (
            // A chart page is blank without its script: the static render
            // (drawn here, no script in the frame) stands in until Run.
            <InlinePaneContent pane={{ ...pane, kind: 'inline' }} />
          ) : (
            <iframe key="static" title={pane.label} sandbox="" srcDoc={gate.srcdoc} referrerPolicy="no-referrer" />
          )}
        </div>
      );
    }
    // Scripts run in an opaque origin: no access to this app, its storage or
    // its relay socket.
    return <iframe key="live" ref={setFrame} title={pane.label} sandbox="allow-scripts" referrerPolicy="no-referrer" />;
  }
  return <PaneContent pane={{ ...pane, url: source.url ?? '' }} />;
}

type VisualizeTab = ReturnType<typeof useVisualizeState>['tabs'][number];

function networkActionLabel(allowed: boolean | undefined, blocked: boolean): string {
  if (allowed) return t('Network allowed');
  return blocked ? t('Network blocked — click to allow') : t('Allow outside network');
}

function problemOrigin(tab: VisualizeTab, problem: NonNullable<VisualizeTab['problems']>[number]): string {
  return [
    tab.panes.length > 1 ? tab.panes[problem.pane]?.label : '',
    typeof problem.version === 'number' ? t('kept v{{n}}', { n: problem.version }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function paneLabelText(tab: VisualizeTab, pane: VisualizePaneView): string {
  if (!tab.compare) return pane.label;
  return `${pane.version !== undefined ? `v${pane.version}` : t('Live')} · ${pane.label}`;
}

export function VisualizePane({ sessionId, active, onClose }: { sessionId: string; active: boolean; onClose(): void }) {
  const state = useVisualizeState(sessionId);
  // Present only on a paired remote client.
  const remoteSource = window.mixdogDesktop?.visualizePaneSource;
  const tab = state.tabs.find((candidate) => candidate.id === state.active) ?? state.tabs.at(-1) ?? null;
  const tabId = tab?.id ?? '';
  // The tab whose page-problem list is expanded.
  const [problemsOpen, setProblemsOpen] = useState('');
  const toggleProblems = (id: string, selected: boolean) => {
    if (!selected) activateVisualizeTab(sessionId, id);
    setProblemsOpen(selected && problemsOpen === id ? '' : id);
  };

  // Remember whether this session's panel is on screen so a renderer reload
  // brings it back. Leaving the session is not hiding it; moving this pane's
  // dock to another view (or closing it) is.
  const shown = useRef({ sessionId: '', active: false });
  useEffect(() => {
    const previous = shown.current;
    if (active) markVisualizePanelShown(sessionId);
    else if (previous.active && previous.sessionId === sessionId) markVisualizePanelHidden(sessionId);
    shown.current = { sessionId, active };
  }, [sessionId, active]);

  // Closing the last tab (the user's × or the agent's close) closes the
  // panel instead of leaving it empty. Unlike the header ×, the next agent
  // open may reveal it again.
  const tabCount = useRef({ sessionId, count: state.tabs.length });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab count reaching zero is the trigger; onClose is read at that moment
  useEffect(() => {
    const previous = tabCount.current;
    tabCount.current = { sessionId, count: state.tabs.length };
    if (!active || previous.sessionId !== sessionId || previous.count === 0 || state.tabs.length > 0) return;
    onClose();
    allowVisualizeReveal(sessionId);
  }, [sessionId, active, state.tabs.length]);

  // Keep the selected tab in view when the strip scrolls, also once the strip
  // has its final width (the panel opening or being resized narrows it).
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = strip.current;
    if (!active || !tabId || !element) return;
    // The whole chip (its badge and close button too), not just the label.
    const reveal = () =>
      element
        .querySelector<HTMLElement>('.browser-tab.is-active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, tabId]);

  // Panes stack when the body is too narrow to give each a usable width.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useLayoutEffect(() => {
    if (!body) return;
    setBodyWidth(body.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setBodyWidth(width);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [body]);
  const stacked = tab ? visualizePanesStacked(bodyWidth, tab.panes.length) : false;

  // The header folds its secondary toggles into ⋯ on a narrow panel.
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useLayoutEffect(() => {
    if (!panel) return;
    setPanelWidth(panel.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setPanelWidth(width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panel]);

  // Comment mode: off by default and per session; Esc or the toggle ends it.
  const [comment, setComment] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => setComment(false), [sessionId]);
  const commentKinds = (tab?.panes ?? []).filter((pane) => visualizeCommentKind(pane.kind)).map((pane) => pane.kind);
  const commentable = commentKinds.length > 0;
  useVisualizeFeedbackBridge({ sessionId, tab, body, comment: comment && commentable, setComment });
  const commentAction = commentable
    ? [
        {
          id: 'comment',
          label: t('Comment'),
          icon: MessageSquarePlus,
          inline: true,
          checked: comment,
          onSelect: () => setComment(!comment),
        },
      ]
    : [];

  // Elements: the active HTML tab read as an outline, interactive elements and
  // layout findings; the findings count shows in the open view's heading.
  const [elementsOpen, setElementsOpen] = useState(false);
  const inspection = useVisualizeInspection({ body, tab, enabled: elementsOpen });
  const hasHtml = Boolean(tab?.panes.some((pane) => pane.kind === 'html'));
  const elementsAction = hasHtml
    ? [
        {
          id: 'elements',
          label: t('Elements'),
          icon: ListTree,
          inline: true,
          checked: elementsOpen,
          onSelect: () => {
            if (!elementsOpen) inspection.refresh();
            setElementsOpen(!elementsOpen);
          },
        },
      ]
    : [];

  // Tweaks: a toolbar button only while the active tab's page declares some;
  // it opens the controls drawer under the toolbar.
  useVisualizeTweaksRevision();
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const hasTweaks = tab ? visualizeTabHasTweaks(sessionId, tab) : false;
  const tweaksAction = hasTweaks
    ? [
        {
          id: 'tweaks',
          label: t('Tweaks'),
          icon: SlidersHorizontal,
          inline: true,
          checked: tweaksOpen,
          onSelect: () => setTweaksOpen(!tweaksOpen),
        },
      ]
    : [];

  // Network state of the active HTML tab: an icon button in the toolbar (the
  // tab chips carry only label + problem count). Highlighted only once the
  // page actually had something blocked.
  const networkBlocked = Boolean(
    tab &&
      !tab.networkAllowed &&
      tab.problems?.some((problem) => problem.kind === 'blocked-network' || problem.kind === 'blocked-navigation')
  );
  const networkAction =
    tab && !remoteSource && tab.panes.some((pane) => pane.kind === 'html')
      ? [
          {
            id: 'network',
            // "Blocked" only once the page actually asked for something.
            label: networkActionLabel(tab.networkAllowed, networkBlocked),
            icon: tab.networkAllowed ? Wifi : WifiOff,
            inline: true,
            attention: networkBlocked,
            onSelect: () => setVisualizeNetwork(sessionId, tab.id, !tab.networkAllowed),
          },
        ]
      : [];

  // "All visuals", the source toggle and the export menu.
  const extras = useVisualizePanelExtras(sessionId, state, tab, Boolean(remoteSource));

  const left = state.tabs.length ? (
    <div ref={strip} className="visualize-tabs" role="tablist" aria-label={t('Visualize')}>
      {state.tabs.map((candidate) => {
        const selected = candidate.id === tab?.id;
        return (
          <div key={candidate.id} className={`browser-tab dock-header-chip${selected ? ' is-active' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="browser-tab-select"
              title={visualizeTabTooltip(candidate)}
              onClick={() => activateVisualizeTab(sessionId, candidate.id)}
            >
              <Eye size={14} aria-hidden="true" />
              <span>{candidate.label}</span>
            </button>
            {candidate.problems?.length ? (
              <button
                type="button"
                className="visualize-problem-badge"
                aria-expanded={selected && problemsOpen === candidate.id}
                title={t('Page problems')}
                onClick={() => toggleProblems(candidate.id, selected)}
              >
                {candidate.problems.length === 1
                  ? t('1 error')
                  : t('{{count}} errors', { count: candidate.problems.length })}
              </button>
            ) : null}
            <button
              type="button"
              className="browser-tab-close"
              aria-label={t('Close tab')}
              data-tooltip={t('Close tab')}
              onClick={() => closeVisualizeTab(sessionId, candidate.id)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  ) : (
    <span className="dock-header-title">{t('Visualize')}</span>
  );
  return (
    <section ref={setPanel} className="visualize-pane" aria-label={t('Visualize')} hidden={!active || undefined}>
      <DockHeaderRow
        className="session-diff-header"
        ariaLabel={t('Visualize')}
        left={left}
        actions={visualizeHeaderActions(
          [...extras.actions, ...tweaksAction, ...elementsAction, ...networkAction, ...commentAction],
          panelWidth
        )}
        onClose={onClose}
      />
      {comment && commentable ? (
        <VisualizeCommentHints sessionId={sessionId} kinds={commentKinds} onEnd={() => setComment(false)} />
      ) : null}
      {tab?.problems?.length && problemsOpen === tab.id ? (
        <ul className="visualize-problems" aria-label={t('Page problems')}>
          {tab.problems.map((problem) => {
            const where = visualizeProblemLocation(problem);
            const origin = problemOrigin(tab, problem);
            return (
              <li key={`${problem.pane}:${problem.kind}:${problem.source}:${problem.line}:${problem.message}`}>
                {origin ? <span className="visualize-problem-origin">{origin}</span> : null}
                <span className="visualize-problem-kind">{problem.kind}</span>
                <span className="visualize-problem-message">{problem.message}</span>
                {where ? <code className="visualize-problem-source">{where}</code> : null}
                {problem.count > 1 ? <span className="visualize-problem-count">×{problem.count}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {tab && hasTweaks && tweaksOpen ? (
        <VisualizeTweaksDrawer sessionId={sessionId} tab={tab} onHide={() => setTweaksOpen(false)} />
      ) : null}
      {extras.strips}
      {tab && hasHtml && elementsOpen ? (
        <VisualizeElements
          tab={tab}
          readings={inspection.readings}
          refresh={inspection.refresh}
          highlight={inspection.highlight}
          onClose={() => setElementsOpen(false)}
          onPin={(pane, selector) => startElementPin(tab.id, pane, selector, setComment)}
        />
      ) : null}
      {tab ? (
        <div
          ref={setBody}
          className={`visualize-body${stacked ? ' is-stacked' : ''}${tab.compare && tab.panes.length > 2 && !stacked ? ' is-compare-grid' : ''}`}
          data-visualize-body=""
          data-visualize-session={sessionId}
          data-visualize-tab={tab.id}
        >
          {tab.panes.map((pane, index) => {
            const showSource = extras.sourceOn && visualizePaneHasSource(pane);
            let content: ReactNode;
            if (showSource) {
              content = <VisualizeSource pane={pane} sessionId={sessionId} tabId={tab.id} index={index} />;
            } else if (pane.kind === 'inline') {
              // Inline content travels in the tab state (host and remote
              // alike) and renders here in the same dead sandbox.
              content = (
                <InlinePaneContent
                  pane={pane}
                  onRendered={(error) => reportVisualizeRender(sessionId, tab.id, index, pane.renderId, error)}
                />
              );
            } else if (remoteSource) {
              content = (
                <RemotePaneContent
                  pane={pane}
                  sessionId={sessionId}
                  tabId={tab.id}
                  index={index}
                  load={remoteSource}
                  commenting={comment && commentable}
                />
              );
            } else {
              content = <PaneContent pane={pane} />;
            }
            return (
              <div
                // The revision remounts a pane when its file changed on disk.
                // biome-ignore lint/suspicious/noArrayIndexKey: panes are positional (pane N is the Nth file), never reordered
                key={`${tab.id}:${tab.revision}:${index}`}
                className="visualize-pane-cell"
                data-visualize-pane={index}
              >
                {tab.panes.length > 1 && (
                  <div
                    className={`visualize-pane-label${pane.version !== undefined ? ' is-snapshot' : ''}`}
                    title={pane.target}
                  >
                    {paneLabelText(tab, pane)}
                  </div>
                )}
                <div className="visualize-pane-content">
                  {content}
                  {visualizeCommentKind(pane.kind) && !showSource && (
                    <VisualizeCommentLayer
                      sessionId={sessionId}
                      tab={tab}
                      pane={pane}
                      index={index}
                      comment={comment && commentable}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="visualize-empty">{t('Results the agent shows will appear here.')}</div>
      )}
    </section>
  );
}
