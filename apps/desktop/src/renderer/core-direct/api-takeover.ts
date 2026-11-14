// provideSecretInput and takeoverReady of the renderer's direct API: the secret card's value goes to the core's one secret
// slot (`approval/provideSecret`) and the takeover card's readiness is the core's answer (`takeover/ready`). Nothing is
// decided or held in this process: the value is sent once and not kept, logged or echoed.
import type { DesktopApi } from '../../shared/contract';
import type { DirectContext } from './context.ts';

/** A secret request id as the runtime mints it (a sign-in card's username and save slots ride it with a suffix). */
const SECRET_REQUEST_ID = /^secret_[A-Za-z0-9-]{8,80}$/;
const MAX_SECRET_LENGTH = 4_096;
const MAX_REQUEST_ID_LENGTH = 120;
const MAX_TAKEOVER_ID_LENGTH = 200;

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string.`);
  if (value.length > maximum) throw new TypeError(`${name} must be at most ${maximum} characters.`);
  return value;
}

export function createTakeoverApi(ctx: DirectContext): Pick<DesktopApi, 'provideSecretInput' | 'takeoverReady'> {
  return {
    provideSecretInput: async (requestId: string, value: string): Promise<boolean> => {
      const id = requiredText(requestId, 'secret request id', MAX_REQUEST_ID_LENGTH);
      const secret = typeof value === 'string' ? value : '';
      // An id the runtime did not mint, or an empty or oversized value, is not taken (and is not sent).
      if (!SECRET_REQUEST_ID.test(id) || !secret || secret.length > MAX_SECRET_LENGTH) return false;
      await ctx.call('approval/provideSecret', { requestId: id, secret });
      return true;
    },
    takeoverReady: async (sessionId: string, id: string): Promise<boolean> => {
      const reply = (await ctx.call('takeover/ready', {
        sessionId: requiredText(sessionId, 'session id', MAX_TAKEOVER_ID_LENGTH),
        takeoverId: requiredText(id, 'takeover id', MAX_TAKEOVER_ID_LENGTH),
      })) as { ready?: unknown } | null;
      return reply?.ready === true;
    },
  };
}
