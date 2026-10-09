// A conversation session's terminal: a tab strip (same structure and look as
// the browser pane's BrowserTabStrip) over one TerminalPane per tab. Every tab
// stays mounted so its PTY and scrollback survive tab switches; only the
// active one is visible. A shell picked from the chevron menu opens a NEW tab.
import { ChevronDown, Maximize2, Minimize2, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ReadyTerminalPane } from './app-shell-components';
import { t } from './i18n';
import { disposeTerminalPane } from './lazy-widgets';
import { wrappedNavigationIndex } from './list-navigation';
import { useMobileBack } from './mobile-back';
import {
  closeSessionTerminalTab,
  getSessionTerminalTabs,
  openSessionTerminalTab,
  selectSessionTerminalTab,
  subscribeSessionTerminalTabs,
} from './session-terminal-tabs';
import { cachedShellProfiles, loadShellProfiles, type ShellProfile } from './terminal-shell-profiles';
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
  const [profiles, setProfiles] = useState<ShellProfile[] | null>(() => cachedShellProfiles());
  const [menuOpen, setMenuOpen] = useState(false);
  // ABB: the shell picker closes on hardware back.
  useMobileBack(menuOpen, () => setMenuOpen(false));
  // Prefetch so the picker opens on a ready list; an opened menu with an
  // empty answer retries once more.
  useEffect(() => {
    if (profiles?.length) return undefined;
    if (profiles !== null && !menuOpen) return undefined;
    let live = true;
    void loadShellProfiles().then((list) => {
      if (live) setProfiles(list);
    });
    return () => {
      live = false;
    };
  }, [profiles, menuOpen]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.dock-terminal-shell')) return;
      setMenuOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown);
    };
  }, [menuOpen]);
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
  const openTab = (shell: string) => {
    setMenuOpen(false);
    openSessionTerminalTab(sessionId, shell);
  };

  return (
    <div className="session-terminal-tabs">
      <div className="browser-tab-toolbar">
        <div
          ref={strip}
          className="browser-tab-list"
          role="tablist"
          aria-label={t('Terminal tabs')}
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
              <div
                key={tab.id}
                className={`browser-tab${isActive ? ' is-active' : ''}`}
                onMouseDown={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  closeTab(tab.id);
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
                >
                  <SquareTerminal size={14} aria-hidden="true" />
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
        <button
          type="button"
          className="browser-tab-new"
          aria-label={t('New tab')}
          data-tooltip={t('New tab')}
          onClick={() => openTab('')}
        >
          <Plus size={16} />
        </button>
        <div className="dock-terminal-shell browser-tab-trailing">
          <button
            type="button"
            className="browser-pane-nav-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('Open new tab with shell')}
            data-tooltip={t('Open new tab with shell')}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <ChevronDown size={16} />
          </button>
          {menuOpen && (
            <div className="dock-terminal-shell-menu" role="menu" aria-label={t('Terminal shells')}>
              {profiles === null && <span className="dock-terminal-shell-note">{t('Detecting shells…')}</span>}
              {profiles?.length === 0 && <span className="dock-terminal-shell-note">{t('No shells detected')}</span>}
              {(profiles?.length ?? 0) > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  title={defaultProfile?.path || t('OS default shell')}
                  onClick={() => openTab('')}
                >
                  <span>{defaultShellLabel}</span>
                </button>
              )}
              {(profiles ?? []).map((profile) => (
                <button
                  type="button"
                  role="menuitem"
                  key={profile.id}
                  title={profile.path}
                  onClick={() => openTab(profile.id)}
                >
                  <span>{profile.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {onToggleExpanded && (
          <button
            type="button"
            className="browser-pane-nav-button"
            aria-label={expanded ? t('Restore terminal') : t('Expand terminal')}
            data-tooltip={expanded ? t('Restore terminal') : t('Expand terminal')}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
      </div>
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
