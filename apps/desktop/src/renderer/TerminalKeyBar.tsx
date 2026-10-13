// Phone-only key row above the soft keyboard: Esc, Tab, sticky Ctrl/Alt, the
// arrows and Ctrl+C. Pointer-down never takes focus from the terminal, so the
// soft keyboard stays open while the bar is used.
import { useSyncExternalStore, type SyntheticEvent } from 'react';

import { t } from './i18n';
import type { StickyModifiers, TerminalBarKey } from './terminal-key-bar';

const preventFocusSteal = (event: SyntheticEvent) => event.preventDefault();

export function TerminalKeyBar({ modifiers, onKey }: { modifiers: StickyModifiers; onKey(key: TerminalBarKey): void }) {
  const armed = useSyncExternalStore(modifiers.subscribe, modifiers.snapshot);
  const key = (id: TerminalBarKey, label: string, ariaLabel?: string) => (
    <button
      type="button"
      className="terminal-key-bar-key"
      data-key={id}
      aria-label={ariaLabel}
      onPointerDown={preventFocusSteal}
      onMouseDown={preventFocusSteal}
      onClick={() => onKey(id)}
    >
      {label}
    </button>
  );
  const sticky = (name: 'ctrl' | 'alt', label: string) => (
    <button
      type="button"
      className="terminal-key-bar-key"
      data-key={name}
      aria-pressed={armed[name]}
      onPointerDown={preventFocusSteal}
      onMouseDown={preventFocusSteal}
      onClick={() => modifiers.toggle(name)}
    >
      {label}
    </button>
  );
  return (
    <div className="terminal-key-bar" role="toolbar" aria-label={t('Terminal keys')}>
      {key('esc', 'Esc')}
      {key('tab', 'Tab')}
      {sticky('ctrl', 'Ctrl')}
      {sticky('alt', 'Alt')}
      {key('left', '←', t('Arrow left'))}
      {key('down', '↓', t('Arrow down'))}
      {key('up', '↑', t('Arrow up'))}
      {key('right', '→', t('Arrow right'))}
      {key('ctrl-c', '^C', t('Interrupt (Ctrl+C)'))}
    </div>
  );
}
