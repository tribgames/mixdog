// The desktop pet's right-click menu, drawn inside the pet window with the
// app's own menu look (.mx-menu / .mx-menu-item) and copy. It stands beside
// the pet inside the resting window: the window never resizes for it.
import { Check, Minus, Plus } from 'lucide-react';
import { Fragment, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DESKTOP_PET_MENU_GAP,
  DESKTOP_PET_MENU_MARGIN,
  DESKTOP_PET_SCALE,
  DESKTOP_PET_SPRITE,
  DESKTOP_PET_THEME_VARS,
  type DesktopPetCommand,
  type DesktopPetTheme,
} from '../shared/desktop-pet';
import { t } from './i18n';

/** The side of the pet its menu opens on: the right unless a menu `width`
 *  wide would run past `screenRight` (the window's on-screen extent, window
 *  px); then the left, which lies on screen whenever the right does not
 *  (main keeps the sprite box inside the work area). `sprite` is the sprite box at the bot's scale. */
export function petMenuSide(
  width: number,
  screenRight: number,
  sprite: { left: number; size: number } = DESKTOP_PET_SPRITE
): 'right' | 'left' {
  const start = sprite.left + sprite.size + DESKTOP_PET_MENU_GAP;
  return start + width + DESKTOP_PET_MENU_MARGIN <= screenRight ? 'right' : 'left';
}

/** The box (window px) around everything the pet draws: the sprite, its
 *  bubble, the quick message and its own menu; null when nothing shows. */
export function petArea(root: ParentNode): { x: number; y: number; width: number; height: number } | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const element of root.querySelectorAll('[data-pet-hit]')) {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  if (right <= left || bottom <= top) return null;
  return {
    x: Math.floor(left),
    y: Math.floor(top),
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top),
  };
}

/** The app's chat look on the pet window: light/dark and the composer's tokens. */
export function applyPetTheme(theme: DesktopPetTheme | null, root: HTMLElement = document.documentElement): void {
  if (!theme) return;
  if (theme.scheme === 'light') root.dataset.mixdogTheme = 'light';
  else delete root.dataset.mixdogTheme;
  root.style.colorScheme = theme.scheme;
  for (const name of DESKTOP_PET_THEME_VARS) {
    const value = theme.vars[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}

export interface PetMenuState {
  pinned: boolean;
  pinnedHere?: boolean;
  /** "Free on screen": anywhere on screen, apart from the app window. */
  onScreen?: boolean;
  keepAbove: boolean;
  collapsed: boolean;
  /** The bot's size in percent (default 100). */
  scale?: number;
}

interface PetMenuEntry {
  command: DesktopPetCommand;
  label: string;
  checked?: boolean;
  separatorBefore?: boolean;
}

/** The menu's items, in order (the same options as Settings → Bots); the
 *  Size row stands between "Collapse bubble" and "Reset position". */
export function petMenuEntries(state: PetMenuState): PetMenuEntry[] {
  return [
    { command: 'open', label: t('Open chat') },
    { command: 'settings', label: t('Settings') },
    { command: 'pin', label: t('Pin above the message box'), checked: state.pinned, separatorBefore: true },
    { command: 'pin-here', label: t('Pin here'), checked: state.pinnedHere === true },
    { command: 'on-screen', label: t('Free on screen'), checked: state.onScreen === true },
    { command: 'keep-above', label: t('Keep above other windows'), checked: state.keepAbove },
    { command: 'collapse', label: t('Collapse bubble'), checked: state.collapsed },
    { command: 'reset', label: t('Reset position') },
    { command: 'off', label: t('Turn off overlay'), separatorBefore: true },
  ];
}

/** One Size step from `scale`, kept within DESKTOP_PET_SCALE. */
export function steppedPetScale(scale: number, direction: -1 | 1): number {
  const next = scale + direction * DESKTOP_PET_SCALE.step;
  return Math.min(DESKTOP_PET_SCALE.max, Math.max(DESKTOP_PET_SCALE.min, next));
}

export function PetMenu({
  state,
  screenRight,
  sprite = DESKTOP_PET_SPRITE,
  onCommand,
  onScale,
  onClose,
}: {
  state: PetMenuState;
  /** The window's on-screen extent from its left (window px). */
  screenRight: number;
  /** The sprite box at the bot's scale (the menu stands beside it). */
  sprite?: { left: number; size: number };
  onCommand: (command: DesktopPetCommand) => void;
  /** The Size row's choice, given once as the menu closes (a new size
   *  replaces the window, which would close the menu under each step). */
  onScale?: (scale: number) => void;
  /** Escape, Tab, an outside click or the window losing focus. */
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [side, setSide] = useState<'right' | 'left'>('right');
  const startScale = state.scale ?? DESKTOP_PET_SCALE.default;
  const [scale, setScale] = useState(startScale);
  const chosen = useRef({ scale, startScale, onScale });
  chosen.current = { scale, startScale, onScale };
  useEffect(
    () => () => {
      const { scale: next, startScale: start, onScale: apply } = chosen.current;
      if (next !== start) apply?.(next);
    },
    []
  );
  const step = (direction: -1 | 1) => {
    const next = steppedPetScale(scale, direction);
    setScale(next);
    // At an end its button disables: the keys stay on the other one.
    const end = direction < 0 ? DESKTOP_PET_SCALE.min : DESKTOP_PET_SCALE.max;
    if (next === end) panel.current?.querySelector<HTMLButtonElement>(`[data-step="${-direction}"]`)?.focus();
  };
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  // Measured before paint: it never shows on the clipped side first.
  useLayoutEffect(() => {
    const width = panel.current?.getBoundingClientRect().width ?? 0;
    setSide(petMenuSide(width, screenRight, sprite));
  }, [screenRight, sprite]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let next = -1;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    } else return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={panel}
      className="mx-menu desktop-pet-menu"
      data-side={side}
      role="menu"
      aria-label={t('Representative bot overlay')}
      data-pet-hit=""
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {petMenuEntries(state).map((entry) => (
        <Fragment key={entry.command}>
          {entry.command === 'reset' && (
            <div className="mx-menu-item desktop-pet-menu-size desktop-pet-menu-separated" role="none">
              <span className="desktop-pet-menu-check" aria-hidden="true" />
              <span id="desktop-pet-menu-size">{t('Size')}</span>
              <button
                type="button"
                role="menuitem"
                className="desktop-pet-menu-step"
                data-step="-1"
                aria-label={t('Smaller')}
                aria-describedby="desktop-pet-menu-size-value"
                disabled={scale <= DESKTOP_PET_SCALE.min}
                onClick={() => step(-1)}
              >
                <Minus size={14} aria-hidden="true" />
              </button>
              <output id="desktop-pet-menu-size-value" className="desktop-pet-menu-size-value" aria-live="polite">
                {`${scale}%`}
              </output>
              <button
                type="button"
                role="menuitem"
                className="desktop-pet-menu-step"
                data-step="1"
                aria-label={t('Larger')}
                aria-describedby="desktop-pet-menu-size-value"
                disabled={scale >= DESKTOP_PET_SCALE.max}
                onClick={() => step(1)}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is menuitemcheckbox whenever checked is defined */}
          <button
            type="button"
            className={`mx-menu-item${entry.separatorBefore ? ' desktop-pet-menu-separated' : ''}`}
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            data-command={entry.command}
            onClick={() => {
              onClose();
              onCommand(entry.command);
            }}
          >
            <span className="desktop-pet-menu-check" aria-hidden="true">
              {entry.checked ? <Check size={14} /> : null}
            </span>
            <span>{entry.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}
