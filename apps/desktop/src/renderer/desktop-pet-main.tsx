// The desktop pet window's renderer (desktop-pet.html). It draws the shared
// pet (skin-companion-pet.tsx) from the view main relays, and hands every
// action back to main through the pet window's own preload (`mixdogPet`).
import './process-shim';
import './desktop/01-tokens.css';
import './desktop/16-overlays.css';
import './desktop-pet.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { petFallbackAvatar, petMascotCells, petMemberAvatar, petPictureSource } from '../shared/desktop-pet-art';
import type { DesktopPetBridge } from '../shared/desktop-pet-bridge';
import {
  type DesktopPetMember,
  type DesktopPetRect,
  type DesktopPetView,
  desktopPetGeometry,
} from '../shared/desktop-pet';
import { AgentImageAvatar } from './agent-avatar';
import { RoomAvatar, RoomMemberFace, type RoomMemberLabel } from './agent-room-parts';
import { applyPetTheme, PetMenu, petArea } from './desktop-pet-menu';
import { initUiLanguage } from './i18n';
import { CompanionPet, focusPet, setPetKeyboardUse, trackPetKeyboardUse } from './skin-companion-pet';
import type { CompanionBubble } from './skin-companion-model';

const pet = (window as unknown as { mixdogPet: DesktopPetBridge }).mixdogPet;

/** A face as a mascot: a picture that cannot be read shows the agent's own
 *  mascot look in its place (usePetPicture). */
function memberLabel(member: DesktopPetMember): RoomMemberLabel {
  return { id: member.id, name: member.name, avatar: petFallbackAvatar(member) };
}

/** The one bot's custom picture: none (a mascot or a room), loading,
 *  ready (its still idle frame), or failed (it cannot be read). */
export type PetPicture =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; src: string }
  | { state: 'failed' };
const NO_PICTURE: PetPicture = { state: 'none' };
const LOADING_PICTURE: PetPicture = { state: 'loading' };

/** A GIF or WebP that came without its stored first frame (an older single
 *  upload): its first frame drawn once to a still PNG, so an animated picture
 *  never repaints the transparent overlay every frame (the pet draws only its
 *  still idle look; it shows no typing/message motion). '' if it cannot be
 *  decoded. A PNG (and every stored first frame) is used as it is. */
function petStillFrame(src: string): Promise<string> {
  if (!/^data:image\/(gif|webp)[;,]/.test(src)) return Promise.resolve(src);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve('');
      }
    };
    image.onerror = () => resolve('');
    image.src = src;
  });
}

/** The one bot's custom picture, read through main once per picture (its
 *  file names are content hashes). */
function usePetPicture(view: DesktopPetView | null): PetPicture {
  const member = view && !view.face.room ? view.face.members[0] : undefined;
  const avatar = member ? petMemberAvatar(member) : null;
  const custom = avatar?.kind === 'custom' ? avatar : null;
  const key = member && custom ? `${member.id}/${Object.values(custom.states).join('/')}` : '';
  const [read, setRead] = useState<{ key: string; picture: PetPicture }>({ key: '', picture: NO_PICTURE });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the member and its picture's files
  useEffect(() => {
    if (!member || !custom) return undefined;
    let current = true;
    const settle = (src: string) => {
      if (current) setRead({ key, picture: src ? { state: 'ready', src } : { state: 'failed' } });
    };
    pet
      .avatarImage(member.id)
      .then((answer) => petStillFrame(petPictureSource(custom, answer)))
      .then(settle, () => settle(''));
    return () => {
      current = false;
    };
  }, [key]);
  if (!key) return NO_PICTURE;
  return read.key === key ? read.picture : LOADING_PICTURE;
}

/** The bubble after this window's own dismissal of a finished reply. */
export function shownBubble(view: DesktopPetView | null, dismissedKey: string): CompanionBubble {
  const bubble = view?.bubble ?? { kind: 'idle' as const };
  return 'key' in bubble && bubble.key === dismissedKey ? { kind: 'idle' } : bubble;
}

/** Empty rows (of the mascot's 12) under the one bot's lowest drawn row: the
 *  sprite is lowered by them so its visible feet are the box's bottom, the
 *  line main stands the bot on. None under a picture (it fills the box),
 *  nor while it loads (the box stands empty in its geometry). */
export function petFeetGap(view: DesktopPetView | null, picture: PetPicture = NO_PICTURE): number {
  if (picture.state === 'ready' || picture.state === 'loading') return 0;
  const rows = petMascotCells(view?.face, true).map((cell) => cell.y);
  return rows.length ? 11 - Math.max(...rows) : 0;
}

/** The pet's face: the room's avatar stack, or its one member's face: its
 *  custom picture once read, an empty box while it loads (never a mascot
 *  flashing first), its mascot look when the picture cannot be read. */
export function petFace(view: DesktopPetView | null, picture: PetPicture) {
  const members = (view?.face.members ?? []).map(memberLabel);
  if (view?.face.room) return <RoomAvatar members={members} className="skin-companion-face" />;
  if (picture.state === 'loading') return <span className="agent-room-face skin-companion-face" />;
  if (picture.state === 'ready') {
    return (
      <span className="agent-room-face skin-companion-face">
        <AgentImageAvatar src={picture.src} />
      </span>
    );
  }
  if (members[0]) return <RoomMemberFace member={members[0]} className="skin-companion-face" />;
  return null;
}

const NO_CUTOUTS: DesktopPetRect[] = [];

/** The point (window px) lies in one of the app's layers cut out of the pet. */
function inCutout(cutouts: readonly DesktopPetRect[], x: number, y: number): boolean {
  return cutouts.some((cut) => x >= cut.x && x < cut.x + cut.width && y >= cut.y && y < cut.y + cut.height);
}

/** `a` less `b`: the parts of `a` outside `b` (at most four). */
function rectMinus(a: DesktopPetRect, b: DesktopPetRect): DesktopPetRect[] {
  const right = a.x + a.width;
  const bottom = a.y + a.height;
  const bRight = b.x + b.width;
  const bBottom = b.y + b.height;
  if (b.x >= right || bRight <= a.x || b.y >= bottom || bBottom <= a.y) return [a];
  const parts: DesktopPetRect[] = [];
  if (b.y > a.y) parts.push({ x: a.x, y: a.y, width: a.width, height: b.y - a.y });
  if (bBottom < bottom) parts.push({ x: a.x, y: bBottom, width: a.width, height: bottom - bBottom });
  const top = Math.max(a.y, b.y);
  const height = Math.min(bottom, bBottom) - top;
  if (b.x > a.x) parts.push({ x: a.x, y: top, width: b.x - a.x, height });
  if (bRight < right) parts.push({ x: bRight, y: top, width: right - bRight, height });
  return parts;
}

/** The whole window less the cut-outs, as a clip-path for #root
 *  (desktop-pet.css): CSS, so it holds on every platform (no window shape),
 *  and clipped-out parts are not hit by the pointer either. The holes are
 *  made disjoint first: two overlapping ones would cancel out under evenodd. */
function petClipPath(cutouts: readonly DesktopPetRect[]): string {
  if (!cutouts.length) return '';
  const holes: DesktopPetRect[] = [];
  for (const cut of cutouts) {
    let parts = [cut];
    for (const hole of holes) parts = parts.flatMap((part) => rectMinus(part, hole));
    holes.push(...parts);
  }
  const rings = holes.map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h${-width}z`).join('');
  return `path(evenodd, "M-1 -1H99999V99999H-1z${rings}")`;
}

/** Clicks pass through every transparent pixel: only the pet, its bubble
 *  and the quick message catch the pointer (main forwards mouse moves),
 *  and not where an app layer is cut out of them (the click is that
 *  layer's). */
function usePointerPassThrough(cutouts: readonly DesktopPetRect[]) {
  const cuts = useRef(cutouts);
  const recheck = useRef(() => {});
  useEffect(() => {
    let interactive = false;
    let pointer: { x: number; y: number; onPet: boolean; held: boolean } | null = null;
    const update = () => {
      const next =
        pointer !== null && (pointer.held || (pointer.onPet && !inCutout(cuts.current, pointer.x, pointer.y)));
      if (next === interactive) return;
      interactive = next;
      pet.interactive(next);
    };
    recheck.current = update;
    const track = (event: MouseEvent) => {
      const onPet = Boolean((event.target as Element | null)?.closest?.('[data-pet-hit]'));
      pointer = { x: event.clientX, y: event.clientY, onPet, held: event.buttons !== 0 };
      update();
    };
    const leave = () => {
      pointer = null;
      update();
    };
    // The window is not focusable until the pet is clicked.
    const press = (event: PointerEvent) => {
      if (
        (event.target as Element | null)?.closest?.('[data-pet-hit]') &&
        !inCutout(cuts.current, event.clientX, event.clientY)
      )
        pet.focusInput(true);
    };
    // The window took focus with nothing in it focused (the system focused
    // it, not a click on the bot): the bot takes the keys (Enter, Shift+F10,
    // the ContextMenu key, arrows), without a ring: the key that switched
    // windows was not pressed here.
    const focused = () => {
      setPetKeyboardUse(false);
      if (document.activeElement && document.activeElement !== document.body) return;
      document
        .querySelector<HTMLElement>('.skin-companion-pet')
        ?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    };
    const untrackKeys = trackPetKeyboardUse();
    document.addEventListener('mousemove', track);
    document.addEventListener('mouseleave', leave);
    document.addEventListener('pointerdown', press);
    window.addEventListener('focus', focused);
    return () => {
      untrackKeys();
      document.removeEventListener('mousemove', track);
      document.removeEventListener('mouseleave', leave);
      document.removeEventListener('pointerdown', press);
      window.removeEventListener('focus', focused);
    };
  }, []);
  // A layer opened or closed under a resting pointer: claimed or passed on now.
  useLayoutEffect(() => {
    cuts.current = cutouts;
    recheck.current();
  }, [cutouts]);
}

function PetApp() {
  const [view, setView] = useState<DesktopPetView | null>(null);
  const [dismissedKey, setDismissedKey] = useState('');
  const [blurSignal, setBlurSignal] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const lastArea = useRef('');
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    pet.focusInput(false);
    focusPet(document.querySelector<HTMLElement>('.skin-companion-pet'));
  }, []);
  useEffect(() => applyPetTheme(view?.theme ?? null), [view?.theme]);
  // The sprite box at the bot's scale (main made the window for it): set
  // before the first paint, so the window never shows another size.
  const shape = useMemo(() => desktopPetGeometry(view?.scale), [view?.scale]);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--pet-size', `${shape.sprite.size}px`);
  }, [shape]);
  // At the screen's top the window is flipped: the bot at its top, all else below.
  const flipped = view?.flipped === true;
  useLayoutEffect(() => {
    if (flipped) document.documentElement.dataset.petFlipped = 'true';
    else delete document.documentElement.dataset.petFlipped;
  }, [flipped]);
  const picture = usePetPicture(view);
  const feetGap = petFeetGap(view, picture);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--pet-feet-gap', String(feetGap));
  }, [feetGap]);
  // What the pet draws (sprite, bubble, quick message), so main can step it
  // aside from the app's own menus under it.
  useLayoutEffect(() => {
    const area = petArea(document);
    const key = JSON.stringify(area);
    if (key === lastArea.current) return;
    lastArea.current = key;
    pet.area(area);
  });
  // Once the pet has drawn with its first view, main may show the window
  // (never an empty or half-drawn frame).
  const hasView = view !== null;
  useEffect(() => {
    if (!hasView) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => pet.painted());
    });
    return () => cancelAnimationFrame(frame);
  }, [hasView]);
  useEffect(() => {
    const offView = pet.onView(setView);
    const offBlur = pet.onBlurred(() => {
      setBlurSignal((count) => count + 1);
      setMenuOpen(false);
    });
    pet.ready();
    return () => {
      offView();
      offBlur();
    };
  }, []);
  // The app's menus, popovers and tooltips over the pet: cut out of all it
  // draws (#root's clip-path), so the pet shows behind them.
  const cutouts = view?.cutouts ?? NO_CUTOUTS;
  const clip = petClipPath(cutouts);
  useLayoutEffect(() => {
    if (clip) document.documentElement.style.setProperty('--pet-clip', clip);
    else document.documentElement.style.removeProperty('--pet-clip');
  }, [clip]);
  usePointerPassThrough(cutouts);
  const face = petFace(view, picture);
  const bubble = shownBubble(view, dismissedKey);
  const pinned = view?.pinned !== false;
  const pinnedHere = !pinned && view?.pinnedHere === true;
  return (
    <>
      <CompanionPet
        face={face}
        name={view && !view.face.room ? (view.face.members[0]?.name ?? '') : ''}
        bubble={bubble}
        collapsed={view?.collapsed === true || menuOpen}
        canSend={Boolean(view?.sessionId)}
        movable={!pinned && !pinnedHere}
        onOpen={() => {
          if ('key' in bubble) setDismissedKey(bubble.key);
          pet.open();
        }}
        onSend={(text) => pet.send(text)}
        onDismiss={setDismissedKey}
        onMenu={() => {
          // The menu needs keyboard focus (arrows, Enter, Esc).
          pet.focusInput(true);
          setMenuOpen(true);
        }}
        onDrag={(drag) => pet.drag(drag)}
        onNudge={(dx, dy) => pet.nudge(dx, dy)}
        onReset={() => pet.reset()}
        onInputFocus={(open) => pet.focusInput(open)}
        blurSignal={blurSignal}
        paused={view?.visible !== true}
        quiet={view?.quiet === true}
        autoAdvance={view?.autoAdvance !== false}
        autoClose={view?.autoClose !== false}
        onRead={(key) => pet.read(key)}
        onCopy={(key) => pet.copy(key)}
        bubbleSpan={view?.bubbleSpan}
      />
      {menuOpen && (
        <PetMenu
          state={{
            pinned,
            pinnedHere,
            onScreen: view?.onScreen === true,
            keepAbove: view?.keepAbove === true,
            collapsed: view?.collapsed === true,
            scale: view?.scale,
          }}
          screenRight={view?.screenRight ?? shape.window.width}
          sprite={shape.sprite}
          onCommand={(command) => pet.command(command)}
          onScale={(scale) => pet.scale(scale)}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

void initUiLanguage()
  .catch(() => undefined)
  .then(() => {
    const root = document.getElementById('root');
    if (root) createRoot(root).render(<PetApp />);
  });
