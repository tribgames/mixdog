import React, {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import { GitDiffPane } from "./GitDiffPane";
import { EditorPane, TerminalPane } from "./lazy-widgets";
import { PaneSurfaceGate } from "./PaneSurfaceGate";
import {
  editorLoadKey,
  ensureEditorLoad,
} from "./renderer-load-metrics";
import { loadStudioViewModule } from "./studio-loader";
import { navigationKey } from "./text-format";

export function StableSessionTitle({
  title,
  editing,
  draft,
  invalid,
  onOpen,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  title: string;
  editing: boolean;
  draft: string;
  invalid: boolean;
  onOpen(): void;
  onDraftChange(value: string): void;
  onCommit(fromBlur?: boolean): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [editing]);
  return <span className="session-title-mode" data-editing={editing ? "true" : "false"}>
    <button type="button" className="session-title-trigger"
      aria-hidden={editing ? true : undefined} tabIndex={editing ? -1 : undefined}
      onClick={onOpen} aria-label={`Rename ${title}`}>
      {title}
    </button>
    <input ref={inputRef} className="session-header-title-input"
      value={draft} maxLength={160} disabled={!editing}
      tabIndex={editing ? undefined : -1}
      aria-hidden={editing ? undefined : true}
      aria-label={`Rename ${title}`}
      aria-invalid={invalid || undefined}
      onInput={(event) => onDraftChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        if (editing) onCommit(true);
      }} />
  </span>;
}

export function shouldKeepFileEditorMounted(
  tabKey: string,
  activeFileKey: string,
  _dirtyFileKeys: ReadonlySet<string>,
  _hotFileKeys: ReadonlySet<string> = new Set(),
): boolean {
  return tabKey === activeFileKey;
}

const HOT_FILE_EDITOR_LIMIT = 4;

export function nextHotFileEditorKeys(
  current: readonly string[],
  active: readonly string[],
  limit = HOT_FILE_EDITOR_LIMIT,
): string[] {
  const seen = new Set<string>();
  return [...active, ...current]
    .filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, limit));
}

export const paneUtilitySurfaceSlotId = (leafId: string, key: string): string =>
  `pane-utility-surface:${leafId}:${key}`;

const loadSchedulesViewModule = () => import("./SchedulesView");
const loadWebhooksViewModule = () => import("./WebhooksView");
const loadProjectsViewModule = () => import("./ProjectsView");
const loadWorkflowsViewModule = () => import("./WorkflowsView");
const loadUtilitiesViewModule = () => import("./UtilitiesView");

export type SidebarPanelKey = "utilities" | "schedules" | "webhooks" | "projects" | "workflows";
type SidebarPanelLoaderGate = (panel: SidebarPanelKey) => Promise<unknown>;

function gateSidebarPanelModule<T>(panel: SidebarPanelKey, load: () => Promise<T>): Promise<T> {
  const gate = (window as typeof window & {
    __mixdogSidebarPanelLoader?: SidebarPanelLoaderGate;
  }).__mixdogSidebarPanelLoader;
  return gate ? Promise.resolve(gate(panel)).then(load) : load();
}

export const loadSidebarPanelModule = {
  utilities: () => gateSidebarPanelModule("utilities", loadUtilitiesViewModule),
  schedules: () => gateSidebarPanelModule("schedules", loadSchedulesViewModule),
  webhooks: () => gateSidebarPanelModule("webhooks", loadWebhooksViewModule),
  projects: () => gateSidebarPanelModule("projects", loadProjectsViewModule),
  workflows: () => gateSidebarPanelModule("workflows", loadWorkflowsViewModule),
} as const;

// A rejected lazy loader stays cached, so each retry needs a fresh component.
export const createSchedulesPane = () => lazy(() => loadSidebarPanelModule.schedules()
  .then((module) => ({ default: module.SchedulesPane })));
export const createUtilitiesPane = () => lazy(() => loadSidebarPanelModule.utilities()
  .then((module) => ({ default: module.UtilitiesPane })));
export const createWebhooksPane = () => lazy(() => loadSidebarPanelModule.webhooks()
  .then((module) => ({ default: module.WebhooksPane })));
export const createProjectsPane = () => lazy(() => loadSidebarPanelModule.projects()
  .then((module) => ({ default: module.ProjectsPane })));
export const createWorkflowsPane = () => lazy(() => loadSidebarPanelModule.workflows()
  .then((module) => ({ default: module.WorkflowsPane })));

const StudioPane = lazy(() => loadStudioViewModule()
  .then((module) => ({ default: module.StudioPane })));

const EDITOR_COVER_MAX_MS = 900;
const TERMINAL_COVER_MAX_MS = 2_000;
export const EDITOR_STARTUP_DELAY_MS = 32;
export const DIFF_STARTUP_DELAY_MS = 64;
export const TERMINAL_STARTUP_DELAY_MS = 96;

export function ReadyEditorPane(props: React.ComponentProps<typeof EditorPane>) {
  const metricKey = editorLoadKey(props.projectPath, props.relPath, props.accessToken);
  beginBootSurface("editor", metricKey);
  ensureEditorLoad(props.projectPath, props.relPath, props.accessToken);
  reportBootSurfaceStage("editor", metricKey, "boundary");
  const [readyKey, setReadyKey] = useState("");
  const [expiredKey, setExpiredKey] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setExpiredKey(metricKey), EDITOR_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [metricKey]);
  return <PaneSurfaceGate
    ready={readyKey === metricKey || expiredKey === metricKey}
    transitionKey={metricKey}
    label="Loading editor…">
    <Suspense fallback={<div className="editor-pane editor-pane-cold-shell" aria-hidden="true" />}>
      <EditorPane {...props} onReady={() => {
        setReadyKey(metricKey);
        reportBootSurfaceStage("editor", metricKey, "dom", "shell");
      }} />
    </Suspense>
  </PaneSurfaceGate>;
}

export function ReadyStudioPane(props: React.ComponentProps<typeof StudioPane>) {
  const metricKey = "studio";
  beginBootSurface("studio", metricKey);
  reportBootSurfaceStage("studio", metricKey, "boundary");
  const [ready, setReady] = useState(false);
  return <PaneSurfaceGate ready={ready} transitionKey={metricKey} label="Preparing Studio…">
    <Suspense fallback={null}>
      <StudioPane {...props} onReady={() => {
        setReady(true);
        reportBootSurfaceStage("studio", metricKey, "dom", "shell");
      }} />
    </Suspense>
  </PaneSurfaceGate>;
}

export function ReadyTerminalPane(props: React.ComponentProps<typeof TerminalPane>) {
  const metricKey = props.terminalId || "bottom-terminal";
  beginBootSurface("terminal", metricKey);
  reportBootSurfaceStage("terminal", metricKey, "boundary");
  const [readyKey, setReadyKey] = useState("");
  // A terminal whose PTY host never answers must still expose its shell and
  // its failure notice. TerminalPane's own reveal fallback dies with the mount
  // effect, so without this expiry the gate can hold "Loading terminal…"
  // indefinitely over a perfectly live xterm.
  const [expiredKey, setExpiredKey] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setExpiredKey(metricKey), TERMINAL_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [metricKey]);
  return <PaneSurfaceGate ready={readyKey === metricKey || expiredKey === metricKey}
    transitionKey={metricKey} label="Loading terminal…">
    <Suspense fallback={null}>
      <TerminalPane {...props} onReady={() => {
        setReadyKey(metricKey);
        reportBootSurfaceReady("terminal", metricKey);
      }} />
    </Suspense>
  </PaneSurfaceGate>;
}

export function ReadyGitDiffPane(props: React.ComponentProps<typeof GitDiffPane>) {
  const metricKey = navigationKey(props.selection);
  beginBootSurface("diff", metricKey);
  reportBootSurfaceStage("diff", metricKey, "boundary");
  const [readyKey, setReadyKey] = useState("");
  return <PaneSurfaceGate ready={readyKey === metricKey}
    transitionKey={metricKey} label="Loading diff…">
    <GitDiffPane {...props} onReady={() => {
      setReadyKey(metricKey);
      reportBootSurfaceStage("diff", metricKey, "dom", "shell");
    }} />
  </PaneSurfaceGate>;
}
