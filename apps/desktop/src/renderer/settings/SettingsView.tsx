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
  Radio,
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
import { acquireTitleBarDim } from '../titlebar-dim';
import { CapabilitySettings, preloadCapabilitySettings } from './CapabilitySettings';
import { preloadConnectionInfo } from './connection-info';
import { preloadGitPanelInfo } from './git-panel-info';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_ITEMS,
  categoryForSettingsItem,
  type SettingsCategory,
} from './settings-items';
import './settings.css';

export type SettingsSection = typeof SETTINGS_ITEMS[number]['value'];

type SettingsApi = Partial<DesktopApi>;

export function preloadSettings(api: SettingsApi): Promise<unknown> {
  return Promise.all([
    preloadCapabilitySettings(api),
    preloadGitPanelInfo(api),
    // Connection is desktop-only (phone shells hide the category), so the
    // background prewarm skips its pairing read there.
    ...(isMobileShell() ? [] : [preloadConnectionInfo(api)]),
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
  channels: Radio,
  connection: Smartphone,
  mcp: Plug,
  plugins: Blocks,
  hooks: Webhook,
  skills: Sparkles,
  system: Wrench,
  shortcuts: Keyboard,
  about: Heart,
} satisfies Record<SettingsCategory, typeof Settings>;

// Phone shell (data-mixdog-mobile, set by mobile-shell.ts before mount):
// Connection is desktop-only — it exists to pair a phone, and the phone IS
// the paired device, so the category is hidden there (user decision).
const isMobileShell = () => document.documentElement.dataset.mixdogMobile === '1';

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
  const [category, setCategory] = useState<SettingsCategory>(
    initialSection ? categoryForSettingsItem(initialSection) : 'general',
  );
  const mobile = isMobileShell();
  const dialogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);

  // Every (re)open starts fresh: explicit section when given, else General
  // (user: the kept-mounted dialog must not resume the last-visited page).
  useEffect(() => {
    if (!open) return;
    setCategory(initialSection ? categoryForSettingsItem(initialSection) : 'general');
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, initialSection]);
  // Windows caption controls are native chrome, outside the DOM backdrop.
  // Hold their matching composited colors for the full settings lifetime.
  useEffect(() => {
    if (!open) return undefined;
    return acquireTitleBarDim();
  }, [open]);
  // Warm the Connection pairing card as soon as the dialog opens (one cached
  // IPC): entering Connection later paints the complete QR card instead of
  // flashing the empty placeholder square first (user: 커넥션 들어갈 때 빈
  // 칸이 거슬린다). Mobile shells hide the category and skip the read.
  useEffect(() => {
    if (!open) return;
    // Git card warms on every open (phone shells included: a missing API
    // resolves to null harmlessly); Connection stays desktop-only.
    void preloadGitPanelInfo(api);
    if (mobile) return;
    void preloadConnectionInfo(api);
  }, [open, mobile, api]);
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
    if (!open) return undefined;
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
  }, [open]);

  // Perf diagnostics: report request→first-paint for the settings dialog
  // (opener stamps __mixdogSettingsOpenAt; main drops lines unless
  // MIXDOG_DESKTOP_PERF=1).
  useEffect(() => {
    if (!open) return;
    const stamped = (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt;
    if (typeof stamped !== 'number') return;
    delete (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.mixdogDesktop?.perfLog?.(`settings-open paint=${(performance.now() - stamped).toFixed(0)}ms`);
    }));
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      const nestedDialog = dialog?.querySelector<HTMLElement>('[data-settings-nested-dialog]') || null;
      if (document.querySelector('.model-picker-dialog[aria-modal="true"]')) return;
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
    <section ref={dialogRef} className="mixdog-settings mixdog-settings-v2" role="dialog" aria-modal="true"
      aria-labelledby="mixdog-settings-title" tabIndex={-1}>
      <aside className="mixdog-settings__rail" aria-label={t('Settings categories')}>
        <nav>
          {/* One flat, evenly spaced list (user decision): the category
              headings AND the gaps between their blocks are gone — twelve
              short rows read better as a single run. `group` survives in the
              data purely as the authoring order. */}
          <div className="mixdog-settings__rail-group">
            {SETTINGS_CATEGORIES.filter((item) => !(mobile && item.value === 'connection')).map((item) => {
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
            <h1 id="mixdog-settings-title">{t(SETTINGS_CATEGORIES.find((item) => item.value === category)?.label || 'Settings')}</h1>
          </div>
          <button ref={closeRef} type="button" className="mixdog-settings__close" onClick={requestClose}
            aria-label={t('Close settings')}><X aria-hidden="true" size={16} className="mixdog-settings__close-x" /><ArrowLeft aria-hidden="true" size={16} className="mixdog-settings__close-back" /></button>
        </header>
        <div ref={bodyRef} className="mixdog-settings__body">
          <div className="mixdog-settings__category-stage">
            <CapabilitySettings api={api} category={category} onCompose={onCompose}
              onOpenCategory={setCategory} />
          </div>
        </div>
      </div>
    </section>
    </div>,
    document.body,
  );
}
