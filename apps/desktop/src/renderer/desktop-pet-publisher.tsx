// The app window's side of the desktop pet (main/desktop-pet-window.ts): the
// setting, and the state of Mixy's home chat published to the pet window
// (the pet is a side chat with Mixy). Its bubble reads the same sources as
// the tab spinner and the status line: the lane snapshot (busy, spinner,
// command status, pending approval) and the session attention index.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { agentHomeSessionId, MIXY_AGENT_ID } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopApi } from '../shared/contract';
import {
  DESKTOP_PET_MAX_LAYERS,
  DESKTOP_PET_THEME_VARS,
  type DesktopPetComposer,
  type DesktopPetConfig,
  type DesktopPetLayers,
  type DesktopPetOption,
  type DesktopPetRect,
  type DesktopPetState,
  type DesktopPetTheme,
} from '../shared/desktop-pet';
import { useAgentChatSession } from './agent-chat-mode';
import { useRequester } from './ApprovalCard';
import { petApproval } from './desktop-pet-approval';
import type { Approval } from './desktop-types';
import { useRoomContacts } from './agent-room-parts';
import { setPetIslandReserve } from './composer-island-state';
import { isSshConnectionWindow } from './desktop-connection';
import { registerElements } from './element-registry';
import { isMobileRemoteSurface } from './mobile-surface';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useSessionAttentionIndex } from './session-attention-index';
import { useMixyCreated } from './mixy-first';
import { useSessionLane } from './session-lane-store';
import { hasOpenModal, subscribeModals } from './settings/dialog-modality';
import { subscribeTitleBarDim, titleBarDimHeld } from './titlebar-dim';
import { companionBubble, latestCompletion } from './skin-companion-model';
import { commandShowsActivity } from './transcript-status';
import { TRANSCRIPT_BOTTOM_SPACER } from './transcript-virtual-cache';

type PetApi = Pick<
  DesktopApi,
  | 'getDesktopPetConfig'
  | 'setDesktopPetEnabled'
  | 'subscribeDesktopPetConfig'
  | 'publishDesktopPet'
  | 'publishDesktopPetComposer'
  | 'publishDesktopPetTheme'
  | 'publishDesktopPetLayers'
  | 'publishDesktopPetAvailable'
  | 'setDesktopPetOption'
  | 'setDesktopPetScale'
  | 'resetDesktopPetPosition'
  | 'onNotificationOpenSession'
  | 'subscribeDesktopPetAppLayout'
>;

function petApi(): PetApi | null {
  const api = (window as unknown as { mixdogDesktop?: PetApi }).mixdogDesktop;
  if (!api?.getDesktopPetConfig || !api.publishDesktopPet) return null;
  // Desktop only: this PC's app window, never a server window, the phone or the web app.
  if (isRemoteHostRenderer() || isSshConnectionWindow() || isMobileRemoteSurface()) return null;
  return api;
}

// ---- The setting -------------------------------------------------------------

let config: DesktopPetConfig | null = null;
let started = false;
const listeners = new Set<() => void>();

function setConfig(next: DesktopPetConfig) {
  config = next;
  for (const listener of [...listeners]) listener();
}

/** The skin's old corner-mascot flag, read once: the overlay is on by default
 *  (main), so only an explicit 'off' carries over, as a stored off. */
const LEGACY_BUDDY_KEY = 'mixdog.desktop.skin-buddy.v1';

export async function migrateLegacyPetSetting(api: PetApi): Promise<void> {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LEGACY_BUDDY_KEY);
  } catch {
    return;
  }
  if (stored === null) return;
  if (stored === 'off' && api.setDesktopPetEnabled) setConfig(await api.setDesktopPetEnabled(false));
  window.localStorage.removeItem(LEGACY_BUDDY_KEY);
}

function start() {
  if (started) return;
  const api = petApi();
  if (!api?.getDesktopPetConfig) return;
  started = true;
  api.subscribeDesktopPetConfig?.(setConfig);
  void api
    .getDesktopPetConfig()
    .then((value) => {
      setConfig(value);
      return migrateLegacyPetSetting(api);
    })
    .catch(() => {});
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pet setting, or null where there is no desktop pet (phone, web, server window). */
export function useDesktopPetConfig(): DesktopPetConfig | null {
  return useSyncExternalStore(
    subscribe,
    () => config,
    () => null
  );
}

export async function setDesktopPetEnabled(enabled: boolean): Promise<void> {
  const api = petApi();
  if (api?.setDesktopPetEnabled) setConfig(await api.setDesktopPetEnabled(enabled));
}

export async function setDesktopPetOption(name: DesktopPetOption, value: boolean): Promise<void> {
  const api = petApi();
  if (api?.setDesktopPetOption) setConfig(await api.setDesktopPetOption(name, value));
}

export async function setDesktopPetScale(scale: number): Promise<void> {
  const api = petApi();
  if (api?.setDesktopPetScale) setConfig(await api.setDesktopPetScale(scale));
}

export async function resetDesktopPetPosition(): Promise<void> {
  const api = petApi();
  if (api?.resetDesktopPetPosition) setConfig(await api.resetDesktopPetPosition());
}

/** Test seam: forget the cached setting. */
export function resetDesktopPetConfigForTests(): void {
  config = null;
  started = false;
  listeners.clear();
}

// ---- Mixy's chat -------------------------------------------------------------

/** The one chat the pet talks to: Mixy's home chat. */
export const DESKTOP_PET_SESSION_ID = agentHomeSessionId(MIXY_AGENT_ID);

/** Sessions the window must keep live for the pet: Mixy's home chat while it is on. */
export function useDesktopPetSessionIds(): string[] {
  const value = useDesktopPetConfig();
  return useMemo(() => (value?.enabled ? [DESKTOP_PET_SESSION_ID] : []), [value]);
}

// Per renderer lifetime: when the pet first saw Mixy's chat and whether it
// watched it work. A turn that finished before either is old history.
let firstSeenAt = 0;
let sawWorking = false;
/** The latest completion that was on screen in Mixy's own chat: seen there,
 *  so the pet never replays it after the user leaves that view. */
let seenKey = '';

/** Test seam: forget what the pet saw this renderer lifetime. */
export function resetDesktopPetSeenForTests(): void {
  firstSeenAt = 0;
  sawWorking = false;
  seenKey = '';
}

/** The focused pane's message field (the pet's click on Mixy's own view). */
const COMPOSER_FIELD_SELECTOR = '.pane-cell.is-focused form.composer textarea';

/** Stands in for the requester lookup while nothing is pending. */
const NO_APPROVAL = {} as Approval;

function PetPublish({ quiet }: { quiet: boolean }) {
  const sessionId = DESKTOP_PET_SESSION_ID;
  const snapshot = useSessionLane(sessionId);
  const attention = useSessionAttentionIndex();
  const { label } = useRoomContacts(true);
  firstSeenAt ||= Date.now();
  const working = Boolean(
    snapshot && (snapshot.busy || commandShowsActivity(snapshot) || attention.waiting.has(sessionId))
  );
  if (working) sawWorking = true;
  const approval = Boolean(snapshot?.toolApproval || attention.needsUser.has(sessionId));
  const completion = useMemo(() => latestCompletion(snapshot?.items ?? []), [snapshot?.items]);
  // On Mixy's own view the chat shows everything: the pet goes quiet and a
  // reply arriving there counts as seen.
  if (quiet && completion) seenKey = completion.key;
  // The request itself, for the bubble to show and decide; a question is
  // answered in the chat (its "!" stays).
  const pending = snapshot?.toolApproval;
  const requester = useRequester(pending ?? NO_APPROVAL, useAgentChatSession(sessionId));
  const requesterName = requester.headAgent || requester.agentName;
  const approvals = useMemo(
    () =>
      pending && pending.kind !== 'question'
        ? [petApproval(pending, { requester: requesterName, agentName: requester.agentName })]
        : [],
    [pending, requesterName, requester.agentName]
  );
  const waiting = 1 + (Number(snapshot?.toolApprovalsWaiting) || 0);
  let bubble: DesktopPetState['bubble'] = quiet
    ? { kind: 'idle' }
    : companionBubble({ working, approval, completion, dismissedKey: seenKey, firstSeenAt, sawWorking });
  if (bubble.kind === 'approval' && approvals.length) bubble = { kind: 'approval', approvals, total: waiting };
  const { id, name, avatar } = label(MIXY_AGENT_ID);
  const state: DesktopPetState = {
    sessionId,
    bubble,
    face: { room: false, members: [{ id, name, avatar }] },
    quiet,
  };
  const key = JSON.stringify(state);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the content signature of state
  useEffect(() => {
    petApi()?.publishDesktopPet?.(state);
  }, [key]);
  // A click on the quiet pet opens Mixy's chat (main's open path, which
  // raises this window): its message field takes the keyboard.
  const quietRef = useRef(quiet);
  quietRef.current = quiet;
  useEffect(
    () =>
      petApi()?.onNotificationOpenSession?.((opened) => {
        if (opened !== DESKTOP_PET_SESSION_ID || !quietRef.current) return;
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>(COMPOSER_FIELD_SELECTOR)?.focus({ preventScroll: true })
        );
      }),
    []
  );
  return null;
}

// ---- The message box the pinned pet stands on ----------------------------------

/** The focused pane's composer card. */
const COMPOSER_SELECTOR = '.pane-cell.is-focused form.composer';

/** The app's floating layers, by role (every menu, listbox popup, dialog and
 *  tooltip carries one) plus the shared menu and dialog classes. */
const FLOATING_SELECTOR =
  '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [role="tooltip"], .mx-menu, .mx-dialog-layer';

/** The side panels (visualize/file/browser panes, the pane dock): docked, not
 *  floating, yet the bot's window is above the whole app, so they are cut out
 *  of it like a menu: the bot stays on the conversation's side of them.
 *  An expanded browser/terminal is not inside its dock: its surface is a
 *  fixed container over the whole main panel (shown ones only: a parked one
 *  sits off screen), and the dock's header widens across the same panel
 *  (surface-slots.ts), both far beyond the dock's own box. */
const SIDE_PANEL_SELECTOR =
  '.workbench-side-panel, .pane-side-dock, .pane-side-dock-header[data-surface-expanded="true"], .session-browser-surface-container[data-parked="false"], .session-terminal-surface-container[data-parked="false"]';

/** The layer and panel candidates, registered as they mount, unmount or
 *  change role/class/expansion/parking: a publish reads these, never the
 *  whole document (a hidden but mounted dock panel can hold ~50k nodes). */
const layerElements = registerElements(`${FLOATING_SELECTOR}, ${SIDE_PANEL_SELECTOR}`, [
  'role',
  'class',
  'data-surface-expanded',
  'data-parked',
]);

const roundedRect = (box: DOMRect): DesktopPetRect => ({
  x: Math.round(box.left),
  y: Math.round(box.top),
  width: Math.round(box.width),
  height: Math.round(box.height),
});

/** A modal dialog with the app's backdrop is open: one that holds the
 *  fullscreen-scrim claim (titlebar-dim: the scrim cannot cover native
 *  chrome, which the pet window is too) or registers with the page-isolating
 *  modality owner (settings/dialog-modality). Menus, popovers, tooltips and
 *  pane-scoped dialogs take neither. */
export function modalBackdropOpen(): boolean {
  return titleBarDimHeld() || hasOpenModal();
}

/** Calls `listener` when a backdrop modal opens or closes; returns the unsubscribe. */
function subscribeModalBackdrop(listener: () => void): () => void {
  const stopClaims = subscribeTitleBarDim(listener);
  const stopModals = subscribeModals(listener);
  return () => {
    stopClaims();
    stopModals();
  };
}

/** The open floating layers: whether a backdrop modal is open (the pet
 *  hides wherever it overlaps the app window, as under the dim), and the
 *  rects (CSS px) of the matches that float (fixed, or absolute over the
 *  page) and have a size (cut out of the pet, which shows behind them). */
export function floatingLayers(): DesktopPetLayers {
  const rects: DesktopPetRect[] = [];
  for (const element of layerElements.list()) {
    const style = window.getComputedStyle(element);
    const floats =
      element.matches(SIDE_PANEL_SELECTOR) ||
      style.position === 'fixed' ||
      (style.position === 'absolute' && style.zIndex !== 'auto');
    if (!floats || style.visibility === 'hidden' || style.display === 'none') continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    rects.push(roundedRect(box));
    if (rects.length >= DESKTOP_PET_MAX_LAYERS) break;
  }
  return { backdrop: modalBackdropOpen(), rects };
}

/** The app's chat look as resolved at `element` (the composer card). */
export function composerTheme(element: Element): DesktopPetTheme {
  const style = window.getComputedStyle(element);
  const vars: Record<string, string> = {};
  for (const name of DESKTOP_PET_THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  // Light themes mark <html data-mixdog-theme="light"> (01-tokens.css); every other is dark.
  const scheme = document.documentElement.dataset.mixdogTheme === 'light' ? 'light' : 'dark';
  return { scheme, vars };
}

/** `send`, but only when the value's content differs from the last one sent. */
function onChange<T>(send: (value: T) => void): (value: T) => void {
  let last: string | undefined;
  return (value) => {
    const key = JSON.stringify(value);
    if (key === last) return;
    last = key;
    send(value);
  };
}

/** The bottom edge (CSS px) of the status island's pill above `card`
 *  while it rests there as a capsule (pill or a flash notice); null for no
 *  island, an empty (hidden) one, the approval card or an expanded panel:
 *  main then takes the line where the pill's bottom would be. */
export function islandPillLine(card: Element): number | null {
  return islandPill(card)?.island ?? null;
}

function islandElement(card: Element): HTMLElement | null {
  return card.closest('.composer-region')?.querySelector<HTMLElement>('.composer-island') ?? null;
}

/** islandPillLine plus the pill's extent and top edge (DesktopPetComposer's
 *  islandSpan), or null when no capsule rests above `card`. */
export function islandPill(card: Element): Pick<Required<DesktopPetComposer>, 'island' | 'islandSpan'> | null {
  const island = islandElement(card);
  const mode = island?.dataset.mode;
  if (!island || (mode !== 'pill' && mode !== 'flash')) return null;
  if (window.getComputedStyle(island).visibility === 'hidden') return null;
  const box = island.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    island: Math.round(box.top + box.height),
    islandSpan: { left: Math.round(box.left), right: Math.round(box.left + box.width), top: Math.round(box.top) },
  };
}

/** The focused pane's transcript column beside `card` (CSS px): the
 *  scroller's left and right, and the line its last row ends on (the
 *  scroller's bottom less its tail gap). Main sets the overlap flag from it
 *  (DesktopPetComposer.transcript). */
export function transcriptColumn(card: Element): DesktopPetComposer['transcript'] {
  const scroller = card.closest('.conversation, .pane-cell')?.querySelector('.transcript');
  if (!scroller) return undefined;
  const box = scroller.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return undefined;
  return {
    left: Math.round(box.left),
    right: Math.round(box.left + box.width),
    bottom: Math.round(box.top + box.height - TRANSCRIPT_BOTTOM_SPACER),
  };
}

/** `html[data-pet-over-transcript]` on or off. */
function setPetOverTranscript(on: boolean) {
  const root = document.documentElement;
  if (on === true) root.setAttribute('data-pet-over-transcript', '');
  else root.removeAttribute('data-pet-over-transcript');
}

/** The card sits under the app's opaque boot cover (the dark screen before
 *  the workspace shows): no composer yet, so the overlay does not appear
 *  over a window that still looks black. */
function underBootCover(card: Element): boolean {
  return card.closest('.desktop-boot-gate')?.getAttribute('data-ready') === 'false';
}

/** Follows the focused pane's composer card: its rect and its island pill's
 *  centre line (CSS px, null when no card shows) go to `publish` on every
 *  `measure`, and as the card or its dock resizes. */
function watchComposerCard(
  publish: (composer: DesktopPetComposer | null) => void,
  onCard: (card: Element | null) => void
) {
  let card: Element | null = null;
  /** The island pill observed with the card: its width follows its status
   *  text, and a wide one puts the pinned bot on top of it. */
  let island: Element | null = null;
  const resize = new ResizeObserver(() => measure());
  const track = () => {
    const next = document.querySelector(COMPOSER_SELECTOR);
    if (next === card) return;
    resize.disconnect();
    card = next;
    island = null;
    onCard(card);
    if (!card) return;
    // The card, the dock around it (an approval card, the footer) and the
    // pane — and every ancestor up to the page: a box that only slides
    // (the side dock or the sidebar opening or closing beside a centred
    // column) changes no size of its own, but the columns around it do.
    resize.observe(card);
    for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) resize.observe(ancestor);
  };
  function measure() {
    if (!card?.isConnected) track();
    if (!card || underBootCover(card)) {
      publish(null);
      return;
    }
    const nextIsland = islandElement(card);
    if (nextIsland !== island) {
      if (island) resize.unobserve(island);
      island = nextIsland;
      if (island) resize.observe(island);
    }
    const box = card.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      publish(null);
      return;
    }
    const transcript = transcriptColumn(card);
    publish({ ...roundedRect(box), ...(islandPill(card) ?? { island: null }), ...(transcript ? { transcript } : {}) });
  }
  return {
    measure,
    card: () => card,
    /** An island pill mounted or replaced since the last measure. */
    islandMoved: () => card !== null && islandElement(card) !== island,
    dispose: () => resize.disconnect(),
  };
}

/** Publishes the open floating layers, at most once a frame. `beforePublish`
 *  runs first, in the same frame callback (the side panels' observers follow
 *  the registered panels, however many DOM mutations arrived). */
function watchLayers(publish: (layers: DesktopPetLayers) => void, beforePublish: () => void) {
  let frame = 0;
  const publishNow = () => {
    frame = 0;
    beforePublish();
    publish(floatingLayers());
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(publishNow);
  };
  return {
    publishNow,
    schedule,
    dispose: () => {
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

/** Calls `onChange` when a side panel's box changes without a DOM insertion:
 *  a resize drag (width via an inline style or token) or a retained panel
 *  opening/closing in place (`hidden`). `track` follows the registered panels. */
function watchSidePanels(onChange: () => void) {
  const resize = new ResizeObserver(onChange);
  const attributes = new MutationObserver(onChange);
  let observed: Element[] = [];
  return {
    track: () => {
      const panels = layerElements.list().filter((element) => element.matches(SIDE_PANEL_SELECTOR));
      if (panels.length === observed.length && panels.every((panel, index) => panel === observed[index])) return;
      resize.disconnect();
      attributes.disconnect();
      observed = panels;
      for (const panel of panels) {
        resize.observe(panel);
        attributes.observe(panel, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
      }
    },
    dispose: () => {
      resize.disconnect();
      attributes.disconnect();
    },
  };
}

/** Publishes the focused pane's composer card rect (CSS px) as it moves or
 *  resizes, and null when no card shows: main pins the pet onto it. */
function PetComposerAnchor({ focusKey }: { focusKey: string }) {
  // Main's answer: whether the pinned bot stands over the transcript's
  // column (the live status row then drops its token readout,
  // 14-live-activity.css), and the width it takes at the card's right end
  // (the card's island goes compact rather than run under it). Main sends it
  // only when it changes, so it is held across focus changes: the same bot
  // beside another pane's card sends nothing new, and that pane's island
  // takes the held width at once.
  const reserve = useRef(0);
  const shareCurrent = useRef(() => {});
  useEffect(() => {
    const stopAppLayout = petApi()?.subscribeDesktopPetAppLayout?.((layout) => {
      setPetOverTranscript(layout.overTranscript);
      reserve.current = layout.islandReserve;
      shareCurrent.current();
    });
    return () => {
      stopAppLayout?.();
      setPetOverTranscript(false);
      setPetIslandReserve(null, 0);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey re-finds the focused pane's card
  useEffect(() => {
    const api = petApi();
    if (!api?.publishDesktopPetComposer) return;
    const shareReserve = (card: Element | null) =>
      setPetIslandReserve(card?.closest('.composer-region') ?? null, reserve.current);
    const cardWatch = watchComposerCard(
      onChange((composer) => api.publishDesktopPetComposer?.(composer)),
      shareReserve
    );
    const { measure } = cardWatch;
    shareCurrent.current = () => shareReserve(cardWatch.card());
    // The chat look, read off the card (skin plates scope their tokens there).
    const sendTheme = onChange<DesktopPetTheme>((theme) => api.publishDesktopPetTheme?.(theme));
    const publishTheme = () => sendTheme(composerTheme(cardWatch.card() ?? document.documentElement));
    // Reading the look resolves the page's style: a change asks for it in
    // the next frame, once, however many DOM batches or root attribute flips
    // (a reload, a reconnect, a session loading) arrive before it.
    let themeStale = false;
    // The app's own menus/popovers/dialogs: the pet shows behind them.
    // Checked once a frame after DOM changes (portals mount into <body>).
    // Side panels (the registered ones, followed before publishing) change
    // width (a resize drag) and `hidden` in place.
    const layersWatch = watchLayers(
      onChange((layers) => api.publishDesktopPetLayers?.(layers)),
      () => {
        sidePanels.track();
        // A side panel opening, closing or resizing (or settling after its
        // transition) can slide the card without resizing any column.
        measure();
        if (themeStale) {
          themeStale = false;
          publishTheme();
        }
      }
    );
    const scheduleTheme = () => {
      themeStale = true;
      layersWatch.schedule();
    };
    const { schedule: scheduleLayers, publishNow: publishLayers } = layersWatch;
    // A backdrop modal opening or closing (some flip in place, no mutation
    // of <body>'s children).
    const stopModalBackdrop = subscribeModalBackdrop(scheduleLayers);
    // A card replaced or removed (session switch, settings page): find it again.
    // The boot cover lifting (data-ready) measures the card it uncovers.
    // A popover that stays mounted and opens in place (data-open, e.g. the
    // context gauge's card) is a layer change too.
    const sidePanels = watchSidePanels(scheduleLayers);
    // A layer or panel registered, removed or moved (a role or class flip too).
    const stopLayerMembership = layerElements.subscribe(scheduleLayers);
    const mutations = new MutationObserver((records) => {
      scheduleLayers();
      if (
        cardWatch.card()?.isConnected &&
        !cardWatch.islandMoved() &&
        !records.some((record) => record.attributeName === 'data-ready')
      )
        return;
      // The frame scheduled above measures the card; the look follows it.
      themeStale = true;
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ready', 'data-open'],
    });
    // Such a popover turns visible or hidden only when its fade ends; a layer
    // also settles after its entrance animation or moves with a scroll.
    document.addEventListener('transitionend', scheduleLayers, true);
    document.addEventListener('animationend', scheduleLayers, true);
    document.addEventListener('scroll', scheduleLayers, { capture: true, passive: true });
    // Backstop: a panel moved by a sibling's resize changes no box of its own.
    document.addEventListener('pointerup', scheduleLayers, true);
    // Theme, skin or accent changes land on <html> (attributes, inline tokens).
    const looks = new MutationObserver(scheduleTheme);
    looks.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    scheme?.addEventListener?.('change', scheduleTheme);
    window.addEventListener('resize', measure);
    window.addEventListener('resize', scheduleLayers);
    measure();
    publishTheme();
    publishLayers();
    return () => {
      cardWatch.dispose();
      shareCurrent.current = () => {};
      stopModalBackdrop();
      mutations.disconnect();
      stopLayerMembership();
      sidePanels.dispose();
      document.removeEventListener('transitionend', scheduleLayers, true);
      document.removeEventListener('animationend', scheduleLayers, true);
      document.removeEventListener('scroll', scheduleLayers, true);
      document.removeEventListener('pointerup', scheduleLayers, true);
      looks.disconnect();
      layersWatch.dispose();
      scheme?.removeEventListener?.('change', scheduleTheme);
      window.removeEventListener('resize', measure);
      window.removeEventListener('resize', scheduleLayers);
    };
  }, [focusKey]);
  // Unmounted (the pet turned off, no workspace): no card.
  useEffect(
    () => () => {
      petApi()?.publishDesktopPetComposer?.(null);
      petApi()?.publishDesktopPetLayers?.({ backdrop: false, rects: [] });
    },
    []
  );
  return null;
}

/** Mounted once in the app window: publishes Mixy's chat and the focused
 *  pane's message box while the pet is on. */
export function DesktopPetPublisher({
  focusKey = '',
  mixyFocused = false,
}: {
  focusKey?: string;
  /** The focused pane shows Mixy's home chat: the pet goes quiet. */
  mixyFocused?: boolean;
}) {
  const value = useDesktopPetConfig();
  if (!value?.enabled) return null;
  return (
    <>
      <PetAvailability />
      <PetPublish quiet={mixyFocused} />
      <PetComposerAnchor focusKey={focusKey} />
    </>
  );
}

/** Whether the representative bot exists — the same answer the Bots page
 *  uses (mixy-first.tsx): the overlay appears only with it. Unknown (not read
 *  yet) sends nothing; main starts from "no". */
function PetAvailability() {
  const created = useMixyCreated(window.mixdogDesktop);
  useEffect(() => {
    if (created !== null) petApi()?.publishDesktopPetAvailable?.(created);
  }, [created]);
  return null;
}
