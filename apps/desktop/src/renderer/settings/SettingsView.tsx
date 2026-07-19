import {
  Blocks,
  Brain,
  Cable,
  Cpu,
  Keyboard,
  PenLine,
  Plug,
  Radio,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Webhook,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi } from '../../shared/contract';
import { CapabilitySettings, preloadCapabilitySettings } from './CapabilitySettings';
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
  return preloadCapabilitySettings(api);
}

export interface SettingsViewProps {
  api?: SettingsApi;
  initialSection?: SettingsSection | null;
  onCompose?: (text: string) => void;
  onClose(): void;
}

const CATEGORY_ICONS = {
  general: SlidersHorizontal,
  models: Cpu,
  workflows: Workflow,
  'output-style': PenLine,
  providers: Cable,
  channels: Radio,
  mcp: Plug,
  plugins: Blocks,
  hooks: Webhook,
  skills: Sparkles,
  memory: Brain,
  system: Wrench,
  shortcuts: Keyboard,
} satisfies Record<SettingsCategory, typeof Settings>;

export interface SettingsTriggerProps {
  onOpen(): void;
  className?: string;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function SettingsTrigger({ onOpen, className }: SettingsTriggerProps) {
  return <button type="button" className={className} aria-label="Open settings" onClick={onOpen}>
    <Settings aria-hidden="true" size={16} />
  </button>;
}

export function SettingsView({
  api = (window as unknown as { mixdogDesktop: DesktopApi }).mixdogDesktop,
  initialSection = null,
  onCompose,
  onClose,
}: SettingsViewProps) {
  const [category, setCategory] = useState<SettingsCategory>(
    initialSection ? categoryForSettingsItem(initialSection) : 'general',
  );
  const [version, setVersion] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (initialSection) setCategory(categoryForSettingsItem(initialSection));
  }, [initialSection]);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [category]);
  useEffect(() => {
    let live = true;
    void api.invokeCapability?.({ capability: 'getUpdateSettings' }).then((result) => {
      const value = result?.value;
      if (live && value && typeof value === 'object' && 'currentVersion' in value) {
        setVersion(String(value.currentVersion || ''));
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [api]);

  const restoreFocus = () => {
    if (priorFocus.current?.isConnected) priorFocus.current.focus();
  };
  const requestClose = () => {
    onClose();
    queueMicrotask(restoreFocus);
  };

  useLayoutEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement
        && !element.matches('.oc-toast-region')
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
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      const nestedDialog = dialog?.querySelector<HTMLElement>('[data-settings-nested-dialog]') || null;
      if (document.querySelector('.model-picker-dialog[aria-modal="true"]')) return;
      if (event.key === 'Escape') {
        const openPortaledMenu = Array.from(
          dialog?.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"][aria-controls]') || [],
        ).some((trigger) => {
          const menu = document.getElementById(trigger.getAttribute('aria-controls') || '');
          return menu?.matches('.oc-menu[role="listbox"]');
        });
        if (openPortaledMenu) return;
        event.preventDefault();
        event.stopPropagation();
        if (nestedDialog) {
          nestedDialog.querySelector<HTMLButtonElement>('[aria-label^="Close"]')?.click();
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
  }, [onClose]);

  return createPortal(
    <div className="mixdog-settings-layer" onPointerDown={(event) => {
      if (event.target !== event.currentTarget) return;
      requestClose();
    }}>
    <section ref={dialogRef} className="mixdog-settings mixdog-settings-v2" role="dialog" aria-modal="true"
      aria-labelledby="mixdog-settings-title" tabIndex={-1}>
      <aside className="mixdog-settings__rail" aria-label="Settings categories">
        <nav>
          {(['Mixdog', 'Integrations', 'Support'] as const).map((group) => <div
            className="mixdog-settings__rail-group" key={group}>
            {group !== 'Mixdog' && <h2>{group}</h2>}
            {SETTINGS_CATEGORIES.filter((item) => item.group === group).map((item) => {
              const Icon = CATEGORY_ICONS[item.value];
              return <button type="button" key={item.value}
                className={category === item.value ? 'active' : ''}
                aria-current={category === item.value ? 'page' : undefined}
                onClick={() => setCategory(item.value)}>
                <Icon aria-hidden="true" size={16} /><span>{item.label}</span>
              </button>;
            })}
          </div>)}
        </nav>
        <footer><strong>Mixdog</strong><span>{version ? `v${version}` : 'Desktop'}</span></footer>
      </aside>
      <div className="mixdog-settings__panel">
        <header className="mixdog-settings__header">
          <div className="mixdog-settings__header-title">
            <h1 id="mixdog-settings-title">{SETTINGS_CATEGORIES.find((item) => item.value === category)?.label || 'Settings'}</h1>
          </div>
          <button ref={closeRef} type="button" className="mixdog-settings__close" onClick={requestClose}
            aria-label="Close settings"><X aria-hidden="true" size={16} /></button>
        </header>
        <div ref={bodyRef} className="mixdog-settings__body">
          <CapabilitySettings api={api} category={category} onCompose={onCompose}
            onOpenCategory={setCategory} />
        </div>
      </div>
    </section>
    </div>,
    document.body,
  );
}
