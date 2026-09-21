import type React from 'react';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import { GitDiffPane } from './GitDiffPane';
import { EditorPane, TerminalPane } from './lazy-widgets';
import { PaneSurfaceGate } from './PaneSurfaceGate';
import { editorLoadKey, ensureEditorLoad } from './renderer-load-metrics';
import { loadStudioViewModule } from './studio-loader';
import { navigationKey } from './text-format';
import { desktopFeatureEnabled } from './desktop-feature-config';

let settingsViewModulePromise: Promise<typeof import('./settings/SettingsView')> | null = null;
export function loadSettingsViewModule() {
  settingsViewModulePromise ||= import('./settings/SettingsView');
  return settingsViewModulePromise;
}
export const SettingsView = lazy(() => loadSettingsViewModule().then((module) => ({ default: module.SettingsView })));
export const loadOnboardingWizardModule = () => import('./settings/OnboardingWizard');
export const OnboardingWizard = lazy(() =>
  loadOnboardingWizardModule().then((module) => ({ default: module.OnboardingWizard }))
);

export function warmSettingsView() {
  if (!desktopFeatureEnabled('settings')) return;
  void loadSettingsViewModule().catch(() => {});
}

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
  return (
    <span className="session-title-mode" data-editing={editing ? 'true' : 'false'}>
      <button
        type="button"
        className="session-title-trigger"
        aria-hidden={editing ? true : undefined}
        tabIndex={editing ? -1 : undefined}
        onClick={onOpen}
        aria-label={`Rename ${title}`}
      >
        {title}
      </button>
      <input
        ref={inputRef}
        className="session-header-title-input"
        value={draft}
        maxLength={160}
        disabled={!editing}
        tabIndex={editing ? undefined : -1}
        aria-hidden={editing ? undefined : true}
        aria-label={`Rename ${title}`}
        aria-invalid={invalid || undefined}
        onInput={(event) => onDraftChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (editing) onCommit(true);
        }}
      />
    </span>
  );
}

export const paneUtilitySurfaceSlotId = (leafId: string, key: string): string =>
  `pane-utility-surface:${leafId}:${key}`;

const loadSchedulesViewModule = () => import('./SchedulesView');
const loadWebhooksViewModule = () => import('./WebhooksView');
const loadProjectsViewModule = () => import('./ProjectsView');
const loadExtensionsViewModule = () => import('./ExtensionsView');

export type SidebarPanelKey = 'schedules' | 'webhooks' | 'projects' | 'extensions';
type SidebarPanelLoaderGate = (panel: SidebarPanelKey) => Promise<unknown>;

function gateSidebarPanelModule<T>(panel: SidebarPanelKey, load: () => Promise<T>): Promise<T> {
  const gate = (
    window as typeof window & {
      __mixdogSidebarPanelLoader?: SidebarPanelLoaderGate;
    }
  ).__mixdogSidebarPanelLoader;
  return gate ? Promise.resolve(gate(panel)).then(load) : load();
}

export const loadSidebarPanelModule = {
  schedules: () => gateSidebarPanelModule('schedules', loadSchedulesViewModule),
  webhooks: () => gateSidebarPanelModule('webhooks', loadWebhooksViewModule),
  projects: () => gateSidebarPanelModule('projects', loadProjectsViewModule),
  extensions: () => gateSidebarPanelModule('extensions', loadExtensionsViewModule),
} as const;

// A rejected lazy loader stays cached, so each retry needs a fresh component.
export const createSchedulesPane = () =>
  lazy(() => loadSidebarPanelModule.schedules().then((module) => ({ default: module.SchedulesPane })));
export const createWebhooksPane = () =>
  lazy(() => loadSidebarPanelModule.webhooks().then((module) => ({ default: module.WebhooksPane })));
export const createProjectsPane = () =>
  lazy(() => loadSidebarPanelModule.projects().then((module) => ({ default: module.ProjectsPane })));
export const createExtensionsPane = () =>
  lazy(() => loadSidebarPanelModule.extensions().then((module) => ({ default: module.ExtensionsPane })));

const StudioPane = lazy(() => loadStudioViewModule().then((module) => ({ default: module.StudioPane })));

const EDITOR_COVER_MAX_MS = 900;
const TERMINAL_COVER_MAX_MS = 2_000;
export const EDITOR_STARTUP_DELAY_MS = 32;
export const DIFF_STARTUP_DELAY_MS = 64;
export const TERMINAL_STARTUP_DELAY_MS = 96;

export function ReadyEditorPane(props: React.ComponentProps<typeof EditorPane>) {
  const metricKey = editorLoadKey(props.projectPath, props.relPath, props.accessToken);
  beginBootSurface('editor', metricKey);
  ensureEditorLoad(props.projectPath, props.relPath, props.accessToken);
  reportBootSurfaceStage('editor', metricKey, 'boundary');
  useEffect(() => {
    reportBootSurfaceReady('editor', metricKey, 'shell');
  }, [metricKey]);
  const [readyKey, setReadyKey] = useState('');
  const [expiredKey, setExpiredKey] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setExpiredKey(metricKey), EDITOR_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [metricKey]);
  return (
    <PaneSurfaceGate
      ready={readyKey === metricKey || expiredKey === metricKey}
      transitionKey={metricKey}
      label="Loading editor…"
    >
      <Suspense fallback={<div className="editor-pane editor-pane-cold-shell" aria-hidden="true" />}>
        <EditorPane
          {...props}
          onReady={() => {
            setReadyKey(metricKey);
            reportBootSurfaceStage('editor', metricKey, 'dom', 'shell');
          }}
        />
      </Suspense>
    </PaneSurfaceGate>
  );
}

// Studio readiness includes the lane catalog, which is a provider network
// read. A slow, rate-limited or offline provider must not hold an opaque cover
// over a gallery and composer that are already interactive — the pane surfaces
// a catalog error and a Retry of its own.
const STUDIO_COVER_MAX_MS = 1_500;

export function ReadyStudioPane(props: React.ComponentProps<typeof StudioPane>) {
  const metricKey = 'studio';
  beginBootSurface('studio', metricKey);
  reportBootSurfaceStage('studio', metricKey, 'boundary');
  useEffect(() => {
    reportBootSurfaceReady('studio', metricKey, 'shell');
  }, []);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), STUDIO_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <PaneSurfaceGate ready={ready || expired} transitionKey={metricKey} label="Preparing Studio…">
      <Suspense fallback={null}>
        <StudioPane
          {...props}
          onReady={() => {
            setReady(true);
            reportBootSurfaceStage('studio', metricKey, 'dom', 'shell');
          }}
        />
      </Suspense>
    </PaneSurfaceGate>
  );
}

export function ReadyTerminalPane(props: React.ComponentProps<typeof TerminalPane>) {
  const metricKey = props.terminalId || 'bottom-terminal';
  beginBootSurface('terminal', metricKey);
  reportBootSurfaceStage('terminal', metricKey, 'boundary');
  useEffect(() => {
    reportBootSurfaceReady('terminal', metricKey, 'shell');
  }, [metricKey]);
  const [readyKey, setReadyKey] = useState('');
  // A terminal whose PTY host never answers must still expose its shell and
  // its failure notice. TerminalPane's own reveal fallback dies with the mount
  // effect, so without this expiry the gate can hold "Loading terminal…"
  // indefinitely over a perfectly live xterm.
  const [expiredKey, setExpiredKey] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setExpiredKey(metricKey), TERMINAL_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [metricKey]);
  return (
    <PaneSurfaceGate
      ready={readyKey === metricKey || expiredKey === metricKey}
      transitionKey={metricKey}
      label="Loading terminal…"
    >
      <Suspense fallback={null}>
        <TerminalPane
          {...props}
          onReady={() => {
            setReadyKey(metricKey);
            reportBootSurfaceStage('terminal', metricKey, 'interactive');
          }}
        />
      </Suspense>
    </PaneSurfaceGate>
  );
}

export function ReadyGitDiffPane(props: React.ComponentProps<typeof GitDiffPane>) {
  const metricKey = navigationKey(props.selection);
  beginBootSurface('diff', metricKey);
  reportBootSurfaceStage('diff', metricKey, 'boundary');
  return (
    <GitDiffPane
      {...props}
      onReady={() => {
        reportBootSurfaceStage('diff', metricKey, 'dom', 'shell');
        reportBootSurfaceReady('diff', metricKey, 'shell');
      }}
    />
  );
}
