import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe, Plus, X } from 'lucide-react';
import { ProgressSpinner } from './ProgressSpinner';
import type { DesktopBrowserTab } from '../shared/contract';
import { t } from './i18n';
import { scrollTabListByWheel } from './pane-dock-chrome';
import { wrappedNavigationIndex } from './list-navigation';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuState,
} from './ScmContextMenu';
import './tab-strip.css';

const ARROW_OFFSETS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

export function BrowserTabStrip({
  tabs,
  onSelect,
  onCreate,
  onClose,
}: {
  tabs: readonly DesktopBrowserTab[];
  onSelect(id: string): Promise<void>;
  /** Omitted when the host cannot open blank tabs (main workspace tab). */
  onCreate?(): Promise<void>;
  onClose(id: string): Promise<void>;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const openMenu = (tab: DesktopBrowserTab, title: string, point: { x: number; y: number }) =>
    setMenu({
      label: title,
      ...point,
      items: [
        { id: 'close-tab', label: t('Close tab'), disabled: busy, onSelect: () => void run(() => onClose(tab.id)) },
        {
          id: 'close-others',
          label: t('Close Others'),
          disabled: busy || tabs.length < 2,
          onSelect: () =>
            void run(async () => {
              for (const other of tabs) if (other.id !== tab.id) await onClose(other.id);
            }),
        },
      ],
    });
  const activeId = tabs.find((tab) => tab.active)?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected tab changing is the trigger; the body only reads the DOM.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } catch {
      /* The page client presents action failures. */
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="browser-tab-toolbar">
      <div
        ref={strip}
        className="browser-tab-list"
        role="tablist"
        aria-label={t('Browser tabs')}
        aria-busy={busy}
        onWheel={(event) => scrollTabListByWheel(event, strip.current)}
        onKeyDown={(event) => {
          const offset = ARROW_OFFSETS[event.key] ?? 0;
          if ((!offset && event.key !== 'Home' && event.key !== 'End') || !tabs.length) return;
          event.preventDefault();
          const index = tabs.findIndex((tab) => tab.active);
          const next = wrappedNavigationIndex(event.key, index, tabs.length, offset);
          void run(() => onSelect(tabs[next].id));
          strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {tabs.map((tab) => {
          const title = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : t('New tab'));
          const TabGlyph = tab.kind === 'popup' ? ExternalLink : Globe;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: middle-click close is a pointer shortcut; the tab's close button is the keyboard path.
            <div
              key={tab.id}
              className={`browser-tab${tab.active ? ' is-active' : ''}`}
              onMouseDown={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                void run(() => onClose(tab.id));
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(tab, title, pointerMenuPoint(event));
              }}
            >
              <button
                type="button"
                role="tab"
                data-page-id={tab.id}
                aria-selected={tab.active}
                tabIndex={tab.active ? 0 : -1}
                disabled={busy}
                className="browser-tab-select"
                title={`${title}\n${tab.url}`}
                onClick={() => void run(() => onSelect(tab.id))}
                onKeyDown={(event) => {
                  if (!isContextMenuKey(event)) return;
                  event.preventDefault();
                  openMenu(tab, title, elementMenuPoint(event.currentTarget));
                }}
              >
                {tab.loading ? (
                  <ProgressSpinner size={15} aria-hidden="true" />
                ) : (
                  <TabGlyph size={15} aria-hidden="true" />
                )}
                <span>{title}</span>
                {tab.kind === 'popup' && <small>{t('Popup')}</small>}
              </button>
              <button
                type="button"
                className="browser-tab-close"
                disabled={busy}
                aria-label={`${t('Close tab')}: ${title}`}
                data-tooltip={t('Close tab')}
                onClick={() => void run(() => onClose(tab.id))}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {onCreate && (
        <button
          type="button"
          className="browser-tab-new"
          disabled={busy || !tabs.length}
          aria-label={t('New tab')}
          data-tooltip={t('New tab')}
          onClick={() => void run(onCreate)}
        >
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}
