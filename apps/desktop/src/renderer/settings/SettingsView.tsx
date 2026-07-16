import { ArrowLeft, Settings, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi } from '../../shared/contract';
import { CapabilitySettings } from './CapabilitySettings';
import { SETTINGS_ITEMS } from './settings-items';
import './settings.css';

export type SettingsSection = typeof SETTINGS_ITEMS[number]['value'];

type SettingsApi = Partial<DesktopApi>;

export interface SettingsViewProps {
  api?: SettingsApi;
  initialSection?: SettingsSection | null;
  onCompose?: (text: string) => void;
  onClose(): void;
}

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
  const [section, setSection] = useState<SettingsSection | null>(initialSection);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);

  useEffect(() => setSection(initialSection), [initialSection]);

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
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog && !element.contains(dialog))
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
      if (event.key === 'Escape') {
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
    <div className="mixdog-settings-layer">
    <section ref={dialogRef} className="mixdog-settings" role="dialog" aria-modal="true"
      aria-labelledby="mixdog-settings-title" tabIndex={-1}>
      <div className="mixdog-settings__panel">
        <header className="mixdog-settings__header">
          <div className="mixdog-settings__header-title">
            {section && <button type="button" className="mixdog-settings__back" aria-label="Back to settings"
              onClick={() => setSection(null)}><ArrowLeft aria-hidden="true" size={16} /></button>}
            <h1 id="mixdog-settings-title">{section
              ? SETTINGS_ITEMS.find((item) => item.value === section)?.label || 'Settings'
              : 'Settings'}</h1>
          </div>
          <button ref={closeRef} type="button" className="mixdog-settings__close" onClick={requestClose}
            aria-label="Close settings"><X aria-hidden="true" size={16} /></button>
        </header>
        <div className="mixdog-settings__body">
          <CapabilitySettings api={api} section={section} onOpen={setSection} onCompose={onCompose} />
        </div>
      </div>
    </section>
    </div>,
    document.body,
  );
}
