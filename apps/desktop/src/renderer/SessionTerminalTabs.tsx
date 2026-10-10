// A conversation session's terminal: a tab strip (same structure and look as
// the browser pane's BrowserTabStrip) over one TerminalPane per tab. Every tab
// stays mounted so its PTY and scrollback survive tab switches; only the
// active one is visible. A shell picked from the header's ⋯ menu opens a NEW tab.
import { Plus, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ReadyTerminalPane } from './app-shell-components';
import { t } from './i18n';
import { disposeTerminalPane } from './lazy-widgets';
import { wrappedNavigationIndex } from './list-navigation';
import { DockHeaderRow, requestPaneDockClose, scrollTabListByWheel, type DockAction } from './pane-dock-chrome';
import {
  closeSessionTerminalTab,
  getSessionTerminalTabs,
  openSessionTerminalTab,
  selectSessionTerminalTab,
  subscribeSessionTerminalTabs,
} from './session-terminal-tabs';
import { cachedShellProfiles, loadShellProfiles, type ShellProfilesState } from './terminal-shell-profiles';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuState,
} from './ScmContextMenu';
import './tab-strip.css';

const ARROW_OFFSETS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

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
  const strip = useRef<HTMLDivElement | null>(null);
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
  // Tab names: the shell's own name (the default tab names the shell it
  // actually spawned); a repeated name gets " 2", " 3", … in tab order.
  const shellName = (shell: string) =>
    shell
      ? profiles?.find((profile) => profile.id === shell)?.label || shell
      : defaultProfile?.label || t('Default shell');
  const nameCounts = new Map<string, number>();
  const tabTitles = new Map(
    state.tabs.map((tab) => {
      const name = shellName(tab.shell);
      const count = (nameCounts.get(name) ?? 0) + 1;
      nameCounts.set(name, count);
      return [tab.id, count > 1 ? `${name} ${count}` : name];
    })
  );
  const closeTab = (id: string) => {
    if (!closeSessionTerminalTab(sessionId, id)) return;
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
  const openTab = (shell: string) => openSessionTerminalTab(sessionId, shell);
  // ⋯ = "open a new tab with this shell" (the former chevron picker).
  let shellActions: DockAction[];
  if (shells.status === 'loading') {
    shellActions = [{ id: 'shell-detecting', label: t('Detecting shells…'), disabled: true, onSelect() {} }];
  } else if (shells.status === 'failed') {
    shellActions = [
      { id: 'shell-failed', label: t('Could not load shells'), disabled: true, onSelect() {} },
      { id: 'shell-retry', label: t('Try again'), onSelect: () => setShells({ status: 'loading' }) },
    ];
  } else if (shells.profiles.length === 0) {
    shellActions = [{ id: 'shell-none', label: t('No shells detected'), disabled: true, onSelect() {} }];
  } else {
    shellActions = [
      { id: 'shell-default', label: defaultShellLabel, icon: Plus, onSelect: () => openTab('') },
      ...shells.profiles.map((profile) => ({
        id: `shell-${profile.id}`,
        label: profile.label,
        icon: Plus,
        onSelect: () => openTab(profile.id),
      })),
    ];
  }

  return (
    <div className="session-terminal-tabs">
      <DockHeaderRow
        onClose={() => requestPaneDockClose('terminal')}
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
              {state.tabs.map((tab) => {
                const isActive = tab.id === state.activeId;
                const title = tabTitles.get(tab.id) ?? '';
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: middle-click close is a pointer shortcut; the tab's close button is the keyboard path.
                  <div
                    key={tab.id}
                    className={`browser-tab${isActive ? ' is-active' : ''}`}
                    onMouseDown={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      closeTab(tab.id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openMenu(tab.id, title, pointerMenuPoint(event));
                    }}
                  >
                    <button
                      type="button"
                      role="tab"
                      data-terminal-id={tab.id}
                      aria-selected={isActive}
                      tabIndex={isActive ? 0 : -1}
                      className="browser-tab-select"
                      title={title}
                      onClick={() => selectSessionTerminalTab(sessionId, tab.id)}
                      onKeyDown={(event) => {
                        if (!isContextMenuKey(event)) return;
                        event.preventDefault();
                        openMenu(tab.id, title, elementMenuPoint(event.currentTarget));
                      }}
                    >
                      <Terminal size={15} aria-hidden="true" />
                      <span>{title}</span>
                    </button>
                    <button
                      type="button"
                      className="browser-tab-close"
                      aria-label={`${t('Close tab')}: ${title}`}
                      data-tooltip={t('Close tab')}
                      onClick={() => closeTab(tab.id)}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
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
              cwd={cwd}
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
