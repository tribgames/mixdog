/**
 * Gestures aimed at a point: click, hover, drag, scroll and key presses. A
 * point comes from a snapshot ref (with automatic stale-ref recovery) or from
 * image-pixel coordinates bound to the latest visual snapshot.
 */
import type { WebContents } from 'electron';

import { OFFSCREEN_VIEWPORT } from '../command';
import { normalizeModifierMask, normalizeMouseButton } from '../input';
import { type BrowserActionContext, defineBrowserActions } from './types';

function pointerKind(command: BrowserActionContext['command'], action: string): 'mouse' | 'touch' {
  const pointer = String(command.pointer || 'mouse').trim().toLowerCase();
  if (pointer !== 'mouse' && pointer !== 'touch') {
    throw new Error(`${action} pointer must be mouse or touch`);
  }
  return pointer;
}

/** Resolve a ref (recovering a stale one once) or a coordinate target. */
async function targetPoint(
  { guest, command, signal, refRecovery, services }: BrowserActionContext,
  ref: string | undefined,
  x: unknown,
  y: unknown,
  label: string,
): Promise<{ x: number; y: number }> {
  if (ref) {
    return services.reply.withRefRecovery(
      guest,
      refRecovery,
      ref,
      (recovered) => services.refPoints.resolveRefPoint(guest, recovered, signal),
      signal,
    );
  }
  return services.refPoints.visualPoint(guest, command, x, y, label, signal);
}

async function finish(context: BrowserActionContext, semantic: boolean) {
  const result = await context.actionSnapshot();
  return semantic ? context.services.reply.decorateRecovery(result, context.refRecovery) : result;
}

export const pointerActions = defineBrowserActions({
  async click(context) {
    const { guest, command, signal, services } = context;
    const pointer = pointerKind(command, 'click');
    const semantic = Boolean(command.ref);
    const point = await targetPoint(context, command.ref, command.x, command.y, 'click');
    const button = normalizeMouseButton(command.button);
    const modifiers = normalizeModifierMask(command.modifiers);
    services.state.invalidateInteraction(guest);
    if (pointer === 'touch') {
      if (command.doubleClick || command.button !== undefined || command.modifiers !== undefined) {
        throw new Error('click pointer=touch does not accept button, modifiers, or doubleClick');
      }
      await services.input.tapAt(guest, point, signal);
    } else {
      await services.input.clickAt(
        guest,
        point.x,
        point.y,
        command.doubleClick ? 2 : 1,
        button,
        modifiers,
        signal,
      );
    }
    return finish(context, semantic);
  },

  async hover(context) {
    const { guest, command, signal, services } = context;
    const semantic = Boolean(command.ref);
    const point = await targetPoint(context, command.ref, command.x, command.y, 'hover');
    services.state.invalidateInteraction(guest);
    await services.input.hoverAt(guest, point.x, point.y, signal);
    return finish(context, semantic);
  },

  async drag(context) {
    const { guest, command, signal, services } = context;
    const pointer = pointerKind(command, 'drag');
    const semantic = Boolean(command.ref);
    const source = await targetPoint(context, command.ref, command.x, command.y, 'drag');
    const destination = semantic
      ? await services.reply.withRefRecovery(
        guest,
        context.refRecovery,
        command.targetRef as string,
        (ref) => services.refPoints.resolveRefPoint(guest, ref, signal),
        signal,
      )
      : await targetPoint(context, undefined, command.targetX, command.targetY, 'drag target');
    services.state.invalidateInteraction(guest);
    if (pointer === 'touch') {
      await services.input.swipeAt(guest, source, destination, signal);
    } else {
      await services.input.dragAt(guest, source, destination, signal);
    }
    return finish(context, semantic);
  },

  async press({ guest, command, signal, actionSnapshot, services }) {
    services.state.invalidateInteraction(guest);
    await services.input.pressKey(guest, command.key || '', signal);
    return actionSnapshot();
  },

  async scroll(context) {
    const { guest, command, signal, refRecovery, actionSnapshot, services } = context;
    const { cdp, state, reply, snapshots, refPoints, input } = services;
    const dx = Number.isFinite(command.dx) ? Math.trunc(command.dx as number) : 0;
    const dy = Number.isFinite(command.dy) ? Math.trunc(command.dy as number) : null;
    const effectiveDy = dy === null && command.dx !== undefined ? 0 : dy;
    const semantic = Boolean(command.ref);
    const coordinate = command.snapshotId !== undefined
      || command.x !== undefined
      || command.y !== undefined;
    const wantedText = String(command.text || '').trim();
    if ([semantic, coordinate, Boolean(wantedText)].filter(Boolean).length > 1) {
      throw new Error('scroll accepts only one target form');
    }
    if (wantedText) {
      // Bringing a known phrase into view without knowing where it sits.
      // A phrase that is not on the page fails rather than scrolling blind.
      const found = await scrollTextIntoView(cdp, guest, wantedText, signal);
      if (!found) {
        throw new Error(`scroll text ${JSON.stringify(wantedText)} was not found on this page; nothing was scrolled`);
      }
      state.invalidateInteraction(guest);
      return reply.decorateRecovery(await actionSnapshot(), refRecovery);
    }
    if (coordinate && (!command.snapshotId
      || !Number.isFinite(command.x)
      || !Number.isFinite(command.y))) {
      throw new Error('scroll coordinate target requires snapshotId, x, and y');
    }
    if (semantic) {
      await reply.withRefRecovery(
        guest,
        refRecovery,
        command.ref as string,
        (ref) => snapshots.evaluateRefScript(
          guest,
          ref,
          scrollWithinRefScript(dx, effectiveDy),
          signal,
          5_000,
        ),
        signal,
      );
      state.invalidateInteraction(guest);
      return reply.decorateRecovery(await actionSnapshot(), refRecovery);
    }
    if (coordinate) {
      const point = await refPoints.visualPoint(guest, command, command.x, command.y, 'scroll', signal);
      state.invalidateInteraction(guest);
      await input.scrollAt(
        guest,
        point,
        dx,
        effectiveDy === null ? Math.round(OFFSCREEN_VIEWPORT.height * 0.8) : effectiveDy,
        signal,
      );
      return actionSnapshot();
    }
    state.invalidateInteraction(guest);
    await cdp.evaluate<{ scrollY: number; scrollHeight: number; viewportHeight: number }>(
      guest,
      `(() => {
        window.scrollBy({
          left: ${String(dx)},
          top: ${effectiveDy === null ? 'Math.round(window.innerHeight * 0.8)' : String(effectiveDy)},
          behavior: 'instant'
        });
        return {
          scrollY: Math.round(window.scrollY),
          scrollHeight: Math.round(document.documentElement.scrollHeight),
          viewportHeight: Math.round(window.innerHeight),
        };
      })()`,
      signal,
    );
    return actionSnapshot();
  },
});

async function scrollTextIntoView(
  cdp: BrowserActionContext['services']['cdp'],
  guest: WebContents,
  wantedText: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const found = await cdp.evaluate<{ found: boolean; text?: string }>(guest, `(() => {
    const wanted = ${JSON.stringify(wantedText.toLowerCase())};
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = String(node.textContent || '');
      if (!value.toLowerCase().includes(wanted)) continue;
      const element = node.parentElement;
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return { found: true, text: value.replace(/\\s+/g, ' ').trim().slice(0, 120) };
    }
    return { found: false };
  })()`, signal);
  return Boolean(found?.found);
}

/** Scroll the nearest scrollable ancestor of the ref'd element. */
function scrollWithinRefScript(dx: number, effectiveDy: number | null): string {
  return `(() => {
    const wantsX = ${String(dx !== 0)};
    const wantsY = ${String(effectiveDy === null || effectiveDy !== 0)};
    let scroller = element;
    while (scroller) {
      const style = getComputedStyle(scroller);
      const canX = /(auto|scroll|overlay)/.test(style.overflowX)
        && scroller.scrollWidth > scroller.clientWidth;
      const canY = /(auto|scroll|overlay)/.test(style.overflowY)
        && scroller.scrollHeight > scroller.clientHeight;
      if ((wantsX && canX) || (wantsY && canY)) break;
      scroller = scroller.parentElement;
    }
    scroller ||= document.scrollingElement || document.documentElement;
    scroller.scrollBy({
      left: ${String(dx)},
      top: ${effectiveDy === null ? 'Math.round(scroller.clientHeight * 0.8)' : String(effectiveDy)},
      behavior: 'instant'
    });
    return {
      scrollLeft: Math.round(scroller.scrollLeft),
      scrollTop: Math.round(scroller.scrollTop),
    };
  })()`;
}
