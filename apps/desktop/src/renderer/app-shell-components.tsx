import type React from 'react';
import { type ComponentType, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import { type DeferredModule, deferredModule, useDeferredModule } from './deferred-module';
import { InitialSurface } from './InitialSurface';
import { EditorTextPlaceholder, useEditorTextPlaceholder } from './editor-text-placeholder';
import { GitDiffPane } from './GitDiffPane';
import { editorPaneModule, type TerminalPane, terminalPaneModule, type EditorPaneProps } from './lazy-widgets';
import { useMobileRemoteSurface } from './mobile-surface';
import { PaneSurfaceGate } from './PaneSurfaceGate';
import { PhoneDeferredMount } from './phone-deferred-mount';
import { editorLoadKey, ensureEditorLoad } from './renderer-load-metrics';
import type { StudioPane as StudioPaneComponent } from './StudioView';
import { studioViewModule } from './studio-loader';
import { t } from './i18n';
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
        aria-label={t('Rename {{name}}', { name: title })}
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
        aria-label={t('Rename {{name}}', { name: title })}
        aria-invalid={invalid || undefined}
        onInput={(event) => onDraftChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
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
const loadWorkflowsViewModule = () => import('./WorkflowsView');
const loadExtensionsViewModule = () => import('./ExtensionsView');
const loadSkillsViewModule = () => import('./SkillsView');

export type SidebarPanelKey = 'schedules' | 'webhooks' | 'projects' | 'workflows' | 'extensions' | 'skills';
type SidebarPanelLoaderGate = (panel: SidebarPanelKey) => Promise<unknown>;

function gateSidebarPanelModule<T>(panel: SidebarPanelKey, load: () => Promise<T>): Promise<T> {
  const gate = (
    window as typeof window & {
      __mixdogSidebarPanelLoader?: SidebarPanelLoaderGate;
    }
  ).__mixdogSidebarPanelLoader;
  return gate ? Promise.resolve(gate(panel)).then(load) : load();
}

// Deferred modules, not React.lazy: a lazy component suspends on its first
// render even when its chunk already loaded, and React then holds the
// Suspense placeholder for its ~300ms reveal throttle. A loaded deferred module
// renders in the same commit as the click.
const sidebarPanelModules = {
  schedules: deferredModule(() => gateSidebarPanelModule('schedules', loadSchedulesViewModule)),
  webhooks: deferredModule(() => gateSidebarPanelModule('webhooks', loadWebhooksViewModule)),
  projects: deferredModule(() => gateSidebarPanelModule('projects', loadProjectsViewModule)),
  workflows: deferredModule(() => gateSidebarPanelModule('workflows', loadWorkflowsViewModule)),
  extensions: deferredModule(() => gateSidebarPanelModule('extensions', loadExtensionsViewModule)),
  skills: deferredModule(() => gateSidebarPanelModule('skills', loadSkillsViewModule)),
};

export const loadSidebarPanelModule = {
  schedules: () => sidebarPanelModules.schedules.load(),
  webhooks: () => sidebarPanelModules.webhooks.load(),
  projects: () => sidebarPanelModules.projects.load(),
  workflows: () => sidebarPanelModules.workflows.load(),
  extensions: () => sidebarPanelModules.extensions.load(),
  skills: () => sidebarPanelModules.skills.load(),
} as const;

/** A rail pane rendered from its deferred module: synchronous once loaded,
 *  the neutral first-read surface until then. A failed import throws to the
 *  panel boundary; its retry builds a fresh pane, whose load starts again. */
function deferredSidebarPane<M, P extends object>(module: DeferredModule<M>, pick: (loaded: M) => ComponentType<P>) {
  return function DeferredSidebarPane(props: P) {
    const loaded = useDeferredModule(module);
    if (!loaded) return <InitialSurface />;
    const Pane = pick(loaded);
    return <Pane {...props} />;
  };
}

export const createSchedulesPane = () => deferredSidebarPane(sidebarPanelModules.schedules, (m) => m.SchedulesPane);
export const createWebhooksPane = () => deferredSidebarPane(sidebarPanelModules.webhooks, (m) => m.WebhooksPane);
export const createProjectsPane = () => deferredSidebarPane(sidebarPanelModules.projects, (m) => m.ProjectsPane);
export const createWorkflowsPane = () => deferredSidebarPane(sidebarPanelModules.workflows, (m) => m.WorkflowsPane);
export const createExtensionsPane = () => deferredSidebarPane(sidebarPanelModules.extensions, (m) => m.ExtensionsPane);
export const createSkillsPane = () => deferredSidebarPane(sidebarPanelModules.skills, (m) => m.SkillsPane);

const EDITOR_COVER_MAX_MS = 900;
const TERMINAL_COVER_MAX_MS = 2_000;
export const EDITOR_STARTUP_DELAY_MS = 32;
export const DIFF_STARTUP_DELAY_MS = 64;
export const TERMINAL_STARTUP_DELAY_MS = 96;

export function ReadyEditorPane(props: EditorPaneProps) {
  const metricKey = editorLoadKey(props.projectPath, props.relPath, props.accessToken);
  // Rendered synchronously once the idle lane (or a hover) has loaded it.
  const editorModule = useDeferredModule(editorPaneModule);
  // The file's plain text covers the pane until the editor is ready.
  const textCover = useEditorTextPlaceholder(props.projectPath, props.relPath, props.accessToken, props.workspaceFile);
  beginBootSurface('editor', metricKey);
  ensureEditorLoad(props.projectPath, props.relPath, props.accessToken);
  reportBootSurfaceStage('editor', metricKey, 'boundary');
  useEffect(() => {
    reportBootSurfaceReady('editor', metricKey, 'shell');
  }, [metricKey]);
  const [readyKey, setReadyKey] = useState('');
  const [expiredKey, setExpiredKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  // The phone paints the file's text first: Monaco's mount is a long task on
  // its CPU, so it waits until the cover's read answered, then mounts one
  // frame after the cover shows (PhoneDeferredMount). The cover's expiry runs
  // from that mount.
  const phone = useMobileRemoteSurface();
  const editorHeld = phone && !textCover.settled;
  useEffect(() => {
    if (editorHeld) return undefined;
    const timer = window.setTimeout(() => setExpiredKey(metricKey), EDITOR_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [metricKey, editorHeld]);
  return (
    <PaneSurfaceGate
      ready={readyKey === metricKey || expiredKey === metricKey}
      transitionKey={metricKey}
      label={t('Loading editor…')}
      fallback={
        textCover.eligible ? (
          <EditorTextPlaceholder
            relPath={props.relPath}
            content={textCover.content}
            side={Boolean(props.onSideChrome)}
          />
        ) : undefined
      }
      onRevealedChange={setRevealed}
    >
      {editorModule && !editorHeld ? (
        <PhoneDeferredMount>
          <editorModule.default
            {...props}
            revealed={revealed}
            onReady={() => {
              setReadyKey(metricKey);
              reportBootSurfaceStage('editor', metricKey, 'dom', 'shell');
            }}
          />
        </PhoneDeferredMount>
      ) : null}
    </PaneSurfaceGate>
  );
}

// Studio readiness includes the lane catalog, which is a provider network
// read. A slow, rate-limited or offline provider must not hold an opaque cover
// over a gallery and composer that are already interactive — the pane surfaces
// a catalog error and a Retry of its own.
const STUDIO_COVER_MAX_MS = 1_500;

export function ReadyStudioPane(props: React.ComponentProps<typeof StudioPaneComponent>) {
  const metricKey = 'studio';
  // Rendered synchronously once the idle lane (or a row hover) has loaded it.
  const studioModule = useDeferredModule(studioViewModule);
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
    <PaneSurfaceGate ready={ready || expired} transitionKey={metricKey} label={t('Preparing Studio…')}>
      {studioModule && (
        <studioModule.StudioPane
          {...props}
          onReady={() => {
            setReady(true);
            reportBootSurfaceStage('studio', metricKey, 'dom', 'shell');
          }}
        />
      )}
    </PaneSurfaceGate>
  );
}

export function ReadyTerminalPane(props: React.ComponentProps<typeof TerminalPane>) {
  const metricKey = props.terminalId || 'bottom-terminal';
  // Rendered synchronously once loaded (the phone's lane, a touch-down).
  const terminalModule = useDeferredModule(terminalPaneModule);
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
      label={t('Loading terminal…')}
    >
      {terminalModule ? (
        <terminalModule.default
          {...props}
          onReady={() => {
            setReadyKey(metricKey);
            reportBootSurfaceStage('terminal', metricKey, 'interactive');
          }}
        />
      ) : null}
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
