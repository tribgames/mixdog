// A conversation session's terminal: a tab strip (same structure and look as
// the browser pane's BrowserTabStrip) over one TerminalPane per tab. Every tab
// stays mounted so its PTY and scrollback survive tab switches; only the
// active one is visible. A shell picked from the header's ⋯ menu opens a NEW tab.
import { Plus, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ReadyTerminalPane } from './app-shell-components';
import { t } from './i18n';
import { disposeTerminalPane } from './lazy-widgets';
import { useForegroundMedia } from './media-lifecycle';
import { getTerminalActivityStates, holdTerminalFocus, subscribeTerminalActivity } from './terminal-activity-store';
import type { TerminalActivityState } from '../shared/terminal-activity';
import { wrappedNavigationIndex } from './list-navigation';
import { DockHeaderRow, requestPaneDockClose, scrollTabListByWheel, type DockAction } from './pane-dock-chrome';
import {
  closeSessionTerminalTab,
  getSessionTerminalTabs,
  followSessionTerminalRoot,
  openSessionTerminalTab,
  selectSessionTerminalTab,
  subscribeSessionTerminalTabs,
  type SessionTerminalTab,
  terminalRootLabel,
} from './session-terminal-tabs';
import {
  cachedShellProfiles,
  loadShellProfiles,
  type ShellProfile,
  type ShellProfilesState,
} from './terminal-shell-profiles';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuState,
} from './ScmContextMenu';
import './tab-strip.css';

const ARROW_OFFSETS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

/** The default shell's name as last detected, so a terminal opened before
 *  this run's detection answers already names it (no "Default shell" →
 *  "PowerShell" swap in the tab). */
const DEFAULT_SHELL_LABEL_KEY = 'mixdog.desktop.terminal-default-shell-label.v1';

export function rememberedDefaultShellLabel(): string {
  try {
    return window.localStorage.getItem(DEFAULT_SHELL_LABEL_KEY) || '';
  } catch {
    return '';
  }
}

function rememberDefaultShellLabel(label: string): void {
  try {
    if (window.localStorage.getItem(DEFAULT_SHELL_LABEL_KEY) !== label) {
      window.localStorage.setItem(DEFAULT_SHELL_LABEL_KEY, label);
    }
  } catch {
    /* the next run detects it again */
  }
}

/** The default tab's shell name: the detected default once profiles answer,
 *  the remembered one while they are still loading. */
export function knownDefaultShellLabel(
  defaultProfile: ShellProfile | null,
  profiles: readonly ShellProfile[] | null,
  remembered: () => string
): string {
  return defaultProfile?.label ?? (profiles ? '' : remembered());
}

// Tab names: the shell's own name (the default tab names the shell it
// actually spawned); a repeated name gets " 2", " 3", … in tab order.
// `defaultLabel`: the detected default shell's name, or the remembered one
// while detection is still answering.
export function terminalTabTitles(
  tabs: readonly SessionTerminalTab[],
  profiles: readonly ShellProfile[] | null,
  defaultLabel: string
): Map<string, string> {
  const shellName = (shell: string) =>
    shell ? profiles?.find((profile) => profile.id === shell)?.label || shell : defaultLabel || t('Default shell');
  const nameCounts = new Map<string, number>();
  // Tabs in different roots (project folder vs. a worktree) show their folder.
  const mixedRoots = new Set(tabs.map((tab) => tab.cwd || '')).size > 1;
  return new Map(
    tabs.map((tab) => {
      const name = shellName(tab.shell);
      const count = (nameCounts.get(name) ?? 0) + 1;
      nameCounts.set(name, count);
      const base = count > 1 ? `${name} ${count}` : name;
      return [tab.id, mixedRoots && tab.cwd ? `${base} · ${terminalRootLabel(tab.cwd)}` : base];
    })
  );
}

// ⋯ = "open a new tab with this shell" (the former chevron picker).
function shellMenuActions(
  shells: ShellProfilesState,
  defaultShellLabel: string,
  openTab: (shell: string) => void,
  retry: () => void
): DockAction[] {
  if (shells.status === 'loading') {
    return [{ id: 'shell-detecting', label: t('Detecting shells…'), disabled: true, onSelect() {} }];
  }
  if (shells.status === 'failed') {
    return [
      { id: 'shell-failed', label: t('Could not load shells'), disabled: true, onSelect() {} },
      { id: 'shell-retry', label: t('Try again'), onSelect: retry },
    ];
  }
  if (shells.profiles.length === 0) {
    return [{ id: 'shell-none', label: t('No shells detected'), disabled: true, onSelect() {} }];
  }
  return [
    { id: 'shell-default', label: defaultShellLabel, icon: Plus, onSelect: () => openTab('') },
    ...shells.profiles.map((profile) => ({
      id: `shell-${profile.id}`,
      label: profile.label,
      icon: Plus,
      onSelect: () => openTab(profile.id),
    })),
  ];
}

function TerminalTabItem({
  id,
  title,
  isActive,
  activity,
  onSelect,
  onClose,
  onMenu,
}: {
  id: string;
  title: string;
  isActive: boolean;
  /** Known command activity; undefined (unknown) or idle shows no dot. */
  activity?: TerminalActivityState;
  onSelect(): void;
  onClose(): void;
  onMenu(title: string, point: { x: number; y: number }): void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: middle-click close is a pointer shortcut; the tab's close button is the keyboard path.
    <div
      className={`browser-tab${isActive ? ' is-active' : ''}`}
      onMouseDown={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(title, pointerMenuPoint(event));
      }}
    >
      <button
        type="button"
        role="tab"
        data-terminal-id={id}
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        className="browser-tab-select"
        title={title}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (!isContextMenuKey(event)) return;
          event.preventDefault();
          onMenu(title, elementMenuPoint(event.currentTarget));
        }}
      >
        <Terminal size={15} aria-hidden="true" />
        <span>{title}</span>
        {(activity === 'running' || activity === 'finished') && (
          <i
            className={`terminal-tab-activity is-${activity}`}
            data-terminal-activity={activity}
            role="status"
            aria-label={
              activity === 'running'
                ? t('{{name}} is running a command', { name: title })
                : t('{{name}} finished a command', { name: title })
            }
          />
        )}
      </button>
      <button
        type="button"
        className="browser-tab-close"
        aria-label={`${t('Close tab')}: ${title}`}
        data-tooltip={t('Close tab')}
        onClick={onClose}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export function SessionTerminalTabs({
  sessionId,
  cwd,
  active,
  expanded = false,
  onToggleExpanded,
}: {
  sessionId: string;
  cwd: string | null;
  active: boolean;
  expanded?: boolean;
  onToggleExpanded?(): void;
}) {
  const state = useSyncExternalStore(subscribeSessionTerminalTabs, () => getSessionTerminalTabs(sessionId));
  const activity = useSyncExternalStore(subscribeTerminalActivity, getTerminalActivityStates);
  // The selected tab of a shown terminal in a focused, visible window is the
  // one the user is looking at: it holds focus, so it never turns "finished".
  const engaged = useForegroundMedia(active);
  useEffect(
    () => (engaged && state.activeId ? holdTerminalFocus(state.activeId) : undefined),
    [engaged, state.activeId]
  );
  const strip = useRef<HTMLDivElement | null>(null);
  const followedRoot = useRef<string | null>(null);
  const hasTabs = state.tabs.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasTabs re-binds a tab reopened after the last one closed.
  useEffect(() => {
    followSessionTerminalRoot(sessionId, cwd, followedRoot.current !== null && followedRoot.current !== cwd);
    followedRoot.current = cwd;
  }, [sessionId, cwd, hasTabs]);
  // Showing a closed terminal creates its fresh tab (in the execution root).
  useEffect(() => {
    if (active && !getSessionTerminalTabs(sessionId).tabs.length) openSessionTerminalTab(sessionId, '', cwd ?? '');
  }, [active, sessionId, cwd]);
  const [shells, setShells] = useState<ShellProfilesState>(() => {
    const cached = cachedShellProfiles();
    return cached ? { status: 'ready', profiles: cached } : { status: 'loading' };
  });
  const profiles = shells.status === 'ready' ? shells.profiles : null;
  // Prefetch so the ⋯ shell list is ready when it opens; "retry" returns to
  // loading, which re-runs this.
  useEffect(() => {
    if (shells.status !== 'loading') return undefined;
    let live = true;
    void loadShellProfiles().then((next) => {
      if (live) setShells(next);
    });
    return () => {
      live = false;
    };
  }, [shells.status]);
  useEffect(() => {
    if (!active || !expanded || !onToggleExpanded) return undefined;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      onToggleExpanded();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [active, expanded, onToggleExpanded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected tab changing is the trigger; the body only reads the DOM.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [state.activeId]);

  // Surface WHAT the default actually spawns (user: 기본 OS 터미널이 나와야).
  const defaultProfile = profiles?.find((profile) => profile.default) ?? null;
  const defaultShellLabel = defaultProfile
    ? t('Default ({{label}})', { label: defaultProfile.label })
    : t('Default shell');
  const knownDefaultLabel = knownDefaultShellLabel(defaultProfile, profiles, rememberedDefaultShellLabel);
  useEffect(() => {
    if (defaultProfile?.label) rememberDefaultShellLabel(defaultProfile.label);
  }, [defaultProfile?.label]);
  const tabTitles = terminalTabTitles(state.tabs, profiles, knownDefaultLabel);
  const closeTab = (id: string) => {
    if (!closeSessionTerminalTab(sessionId, id)) return;
    if (!getSessionTerminalTabs(sessionId).tabs.length) requestPaneDockClose('terminal', sessionId);
    // Dispose after the pane has unmounted so its cleanup cannot re-persist
    // the disposed terminal's view state.
    setTimeout(() => void disposeTerminalPane(id), 0);
  };
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const openMenu = (id: string, title: string, point: { x: number; y: number }) =>
    setMenu({
      label: title,
      ...point,
      items: [
        { id: 'close-tab', label: t('Close tab'), onSelect: () => closeTab(id) },
        {
          id: 'close-others',
          label: t('Close Others'),
          disabled: state.tabs.length < 2,
          onSelect: () => {
            for (const other of state.tabs) if (other.id !== id) closeTab(other.id);
          },
        },
      ],
    });
  const openTab = (shell: string) => openSessionTerminalTab(sessionId, shell, cwd ?? '');
  const shellActions = shellMenuActions(shells, defaultShellLabel, openTab, () => setShells({ status: 'loading' }));

  return (
    <div className="session-terminal-tabs">
      <DockHeaderRow
        onClose={() => requestPaneDockClose('terminal', sessionId)}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        expandLabel={t('Expand terminal')}
        restoreLabel={t('Restore terminal')}
        actions={shellActions}
        left={
          <div className="browser-tab-toolbar">
            <div
              ref={strip}
              className="browser-tab-list"
              role="tablist"
              aria-label={t('Terminal tabs')}
              onWheel={(event) => scrollTabListByWheel(event, strip.current)}
              onKeyDown={(event) => {
                const offset = ARROW_OFFSETS[event.key] ?? 0;
                if ((!offset && event.key !== 'Home' && event.key !== 'End') || !state.tabs.length) return;
                event.preventDefault();
                const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
                const next = wrappedNavigationIndex(event.key, index, state.tabs.length, offset);
                selectSessionTerminalTab(sessionId, state.tabs[next].id);
                strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              }}
            >
              {state.tabs.map((tab) => (
                <TerminalTabItem
                  key={tab.id}
                  id={tab.id}
                  title={tabTitles.get(tab.id) ?? ''}
                  isActive={tab.id === state.activeId}
                  activity={activity.get(tab.id)}
                  onSelect={() => selectSessionTerminalTab(sessionId, tab.id)}
                  onClose={() => closeTab(tab.id)}
                  onMenu={(title, point) => openMenu(tab.id, title, point)}
                />
              ))}
            </div>
            <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
            <button
              type="button"
              className="browser-tab-new"
              aria-label={t('New tab')}
              data-tooltip={t('New tab')}
              onClick={() => openTab('')}
            >
              <Plus size={15} />
            </button>
          </div>
        }
      />
      <div className="session-terminal-tab-panels">
        {state.tabs.map((tab) => (
          <div key={tab.id} className="session-terminal-tab-panel" hidden={tab.id !== state.activeId}>
            <ReadyTerminalPane
              cwd={tab.cwd || cwd}
              terminalId={tab.id}
              shell={tab.shell}
              active={active && tab.id === state.activeId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
