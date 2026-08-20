import {
  ArrowLeft,
  Blocks,
  Brain,
  Cable,
  GitBranch,
  Heart,
  Keyboard,
  PenLine,
  Plug,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Webhook,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { acquireTitleBarDim, refreshTitleBarDim } from '../titlebar-dim';
import { CapabilitySettings, getCachedCapabilitySettings, preloadCapabilitySettings } from './CapabilitySettings';
import { preloadConnectionInfo } from './connection-info';
import { preloadGitPanelInfo } from './git-panel-info';
import {
  SETTINGS_ITEMS,
  categoryForSettingsItem,
  settingsCategoriesForSurface,
  settingsCategoryForSurface,
  type SettingsCategory,
} from './settings-items';
import './settings.css';

export type SettingsSection = typeof SETTINGS_ITEMS[number]['value'];

type SettingsApi = Partial<DesktopApi>;

export function preloadSettings(api: SettingsApi): Promise<unknown> {
  return Promise.all([
    preloadCapabilitySettings(api),
    preloadGitPanelInfo(api),
    preloadConnectionInfo(api),
  ]);
}

export { preloadConnectionInfo };

export interface SettingsViewProps {
  api?: SettingsApi;
  /** The parent mounts this dialog only while open. */
  open?: boolean;
  initialSection?: SettingsSection | null;
  onCompose?: (text: string) => void;
  onClose(): void;
}

const CATEGORY_ICONS = {
  general: SlidersHorizontal,
  context: Brain,
  'output-style': PenLine,
  providers: Cable,
  git: GitBranch,
  connection: Smartphone,
  mcp: Plug,
  plugins: Blocks,
  hooks: Webhook,
  skills: Sparkles,
  system: Wrench,
  shortcuts: Keyboard,
  about: Heart,
} satisfies Record<SettingsCategory, typeof Settings>;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function SettingsView({
  api = (window as unknown as { mixdogDesktop: DesktopApi }).mixdogDesktop,
  open = true,
  initialSection = null,
  onCompose,
  onClose,
}: SettingsViewProps) {
  const remoteSettings = Boolean(
    (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer,
  );
  const visibleCategories = settingsCategoriesForSurface(remoteSettings);
  const resolveCategory = (next: SettingsCategory): SettingsCategory =>
    settingsCategoryForSurface(next, remoteSettings);
  const [category, setCategory] = useState<SettingsCategory>(
    resolveCategory(initialSection ? categoryForSettingsItem(initialSection) : 'general'),
  );
  const dialogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  // The settings shell is navigation chrome, not data: it must open
  // immediately while individual rows quietly adopt the shared cache.
  const coldHydrating = false;
  useEffect(() => {
    if (!open || getCachedCapabilitySettings(api)) return;
    void preloadCapabilitySettings(api).catch(() => undefined);
  }, [open, api]);

  // Every (re)open starts fresh: explicit section when given, else General
  // (user: the kept-mounted dialog must not resume the last-visited page).
  useEffect(() => {
    if (!open) return;
    setCategory(resolveCategory(initialSection ? categoryForSettingsItem(initialSection) : 'general'));
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, initialSection, remoteSettings]);
  // Windows caption controls are native chrome, outside the DOM backdrop.
  // Hold their matching composited colors for the full settings lifetime.
  useEffect(() => {
    if (!open) return undefined;
    return acquireTitleBarDim();
  }, [open]);
  // The cold backplate and the mounted dialog paint different scrims: the
  // claim above samples whichever is live, so re-sample when the dialog
  // replaces the overlay (and jsdom tests see the composited color without
  // relying on the rAF follow window).
  useEffect(() => {
    if (!open || coldHydrating) return;
    refreshTitleBarDim();
  }, [open, coldHydrating]);
  // Warm the Connection pairing card as soon as the dialog opens (one cached
  // IPC): entering Connection later paints the complete QR card instead of
  // flashing the empty placeholder square first (user: 커넥션 들어갈 때 빈
  // 칸이 거슬린다).
  useEffect(() => {
    if (!open) return;
    void preloadGitPanelInfo(api);
    void preloadConnectionInfo(api);
  }, [open, api]);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [category]);

  const restoreFocus = () => {
    if (priorFocus.current?.isConnected) priorFocus.current.focus();
  };
  const requestClose = () => {
    onClose();
    queueMicrotask(restoreFocus);
  };

  useLayoutEffect(() => {
    // While the cold overlay is up there is no dialog to trap focus in; the
    // trap arms when the populated dialog actually mounts.
    if (!open || coldHydrating) return undefined;
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement
        && !element.matches('.mx-toast-region')
        && element !== dialog
        && !element.contains(dialog))
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    for (const { element } of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    closeRef.current?.focus();
    return () => {
      for (const { element, inert, ariaHidden } of background) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      restoreFocus();
    };
  }, [open, coldHydrating]);

  // Perf diagnostics: report request→first-paint for the settings dialog
  // (opener stamps __mixdogSettingsOpenAt; main drops lines unless
  // MIXDOG_DESKTOP_PERF=1).
  useEffect(() => {
    // The stamp is consumed at CONTENT paint, so cold opens report the full
    // overlay wait instead of the overlay's own first frame.
    if (!open || coldHydrating) return;
    const stamped = (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt;
    if (typeof stamped !== 'number') return;
    delete (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.mixdogDesktop?.perfLog?.(`settings-open paint=${(performance.now() - stamped).toFixed(0)}ms`);
    }));
  }, [open, coldHydrating]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      const nestedDialog = dialog?.querySelector<HTMLElement>('[data-settings-nested-dialog]') || null;
      if (event.key === 'Escape') {
        const openPortaledMenu = Array.from(
          dialog?.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"][aria-controls]') || [],
        ).some((trigger) => {
          const menu = document.getElementById(trigger.getAttribute('aria-controls') || '');
          return menu?.matches('.mx-menu[role="listbox"]');
        });
        if (openPortaledMenu) return;
        event.preventDefault();
        event.stopPropagation();
        if (nestedDialog) {
          // Close buttons carry data-settings-nested-close because their
          // aria-labels are localized ("Close…" only holds in English).
          nestedDialog.querySelector<HTMLButtonElement>('[data-settings-nested-close], [aria-label^="Close"]')?.click();
          return;
        }
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      if (!dialog) return;
      const focusRoot = nestedDialog || dialog;
      const queried = Array.from(focusRoot.querySelectorAll<HTMLElement>(FOCUSABLE));
      const controls = !nestedDialog && closeRef.current
        ? [closeRef.current, ...queried.filter((control) => control !== closeRef.current)]
        : queried;
      if (!controls.length) {
        event.preventDefault();
        focusRoot.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !focusRoot.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !focusRoot.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [open, onClose]);

  return createPortal(
    <div className="mixdog-settings-layer stable-surface-preserved"
      data-surface-active={open ? 'true' : 'false'}
      inert={open ? undefined : true} aria-hidden={open ? undefined : true}
      onPointerDown={(event) => {
      if (event.target !== event.currentTarget) return;
      requestClose();
    }}>
    {/* A CLOSED settings dialog stays mounted for a warm reopen, so it must
        stop claiming to be modal — the workbench keymap treats any live
        aria-modal dialog as the owner of every keystroke. */}
    <section ref={dialogRef} className="mixdog-settings mixdog-settings-v2" role="dialog"
      aria-modal={open ? 'true' : 'false'}
      aria-labelledby="mixdog-settings-title" tabIndex={-1}>
      <aside className="mixdog-settings__rail" aria-label={t('Settings categories')}>
        <nav>
          {/* One flat, evenly spaced list (user decision): the category
              headings AND the gaps between their blocks are gone — twelve
              short rows read better as a single run. `group` survives in the
              data purely as the authoring order. */}
          <div className="mixdog-settings__rail-group">
            {visibleCategories.map((item) => {
              const Icon = CATEGORY_ICONS[item.value];
              return <button type="button" key={item.value}
                className={category === item.value ? 'active' : ''}
                aria-label={t(item.label)}
                aria-current={category === item.value ? 'page' : undefined}
                onClick={() => setCategory(item.value)}>
                <Icon aria-hidden="true" size={16} /><span>{t(item.label)}</span>
              </button>;
            })}
          </div>
        </nav>
        {/* No brand/version footer (user decision): the nav ends with its
            last category. */}
      </aside>
      <div className="mixdog-settings__panel">
        <header className="mixdog-settings__header">
          <div className="mixdog-settings__header-title">
            <h1 id="mixdog-settings-title">{t(visibleCategories.find((item) => item.value === category)?.label || 'Settings')}</h1>
          </div>
          <button ref={closeRef} type="button" className="mixdog-settings__close" onClick={requestClose}
            aria-label={t('Close settings')}><X aria-hidden="true" size={16} className="mixdog-settings__close-x" /><ArrowLeft aria-hidden="true" size={16} className="mixdog-settings__close-back" /></button>
        </header>
        <div ref={bodyRef} className="mixdog-settings__body">
          <div className="mixdog-settings__category-stage">
            <CapabilitySettings api={api} category={category} onCompose={onCompose}
              onOpenCategory={(next) => setCategory(resolveCategory(next))} />
          </div>
        </div>
      </div>
    </section>
    </div>,
    document.body,
  );
}
