import type { DesktopPetDrag, DesktopPetView } from './desktop-pet';

/** `window.mixdogPet`: the pet window's whole bridge (preload/desktop-pet.ts).
 *  No session id, route or credential crosses it: main sends to the session
 *  the app window last published. */
export interface DesktopPetBridge {
  onView(listener: (view: DesktopPetView) => void): () => void;
  onBlurred(listener: () => void): () => void;
  ready(): void;
  /** The pet has drawn its first frame with the view: main may show the window. */
  painted(): void;
  send(text: string): Promise<boolean>;
  open(): void;
  /** The reply with this key was read in the bubble (shown, a long one to
   *  its last page): main marks its chat read. */
  read(key: string): void;
  /** Copy the whole reply with this key to the clipboard. */
  copy(key: string): void;
  /** One of the pet menu's items (DesktopPetCommand). */
  command(command: string): void;
  /** The box the pet, its bubble and its quick message cover (window px). */
  area(rect: { x: number; y: number; width: number; height: number } | null): void;
  drag(drag: DesktopPetDrag): void;
  nudge(dx: number, dy: number): void;
  reset(): void;
  /** The menu's Size row, applied as the menu closes (DESKTOP_PET_SCALES). */
  scale(scale: number): void;
  interactive(on: boolean): void;
  focusInput(open: boolean): void;
  /** The face's custom picture (getAgentAvatarImage's answer: data URLs by
   *  state), or null: only for a member of the face main relays. */
  avatarImage(agentId: string): Promise<unknown>;
}

/** Channels on the pet window's own webContents.ipc. Only the pet preload
 *  and main import this file (a sandboxed preload cannot load shared chunks). */
export const DESKTOP_PET_WINDOW_IPC = {
  /** main → pet: what to draw. */
  view: 'mixdog-pet:view',
  /** pet → main. */
  ready: 'mixdog-pet:ready',
  painted: 'mixdog-pet:painted',
  send: 'mixdog-pet:send',
  open: 'mixdog-pet:open',
  read: 'mixdog-pet:read',
  copy: 'mixdog-pet:copy',
  command: 'mixdog-pet:command',
  area: 'mixdog-pet:area',
  drag: 'mixdog-pet:drag',
  nudge: 'mixdog-pet:nudge',
  reset: 'mixdog-pet:reset',
  scale: 'mixdog-pet:scale',
  interactive: 'mixdog-pet:interactive',
  focusInput: 'mixdog-pet:focus-input',
  /** pet → main (invoke): the face's custom picture. */
  avatarImage: 'mixdog-pet:avatar-image',
  /** main → pet: the window lost focus (closes the quick message). */
  blurred: 'mixdog-pet:blurred',
} as const;
