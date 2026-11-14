// provideSecretInput and takeoverReady of the renderer's direct API: the secret card's value goes to the core's one secret
// slot (`approval/provideSecret`) and the takeover card's readiness is the core's answer (`takeover/ready`). Nothing is
// decided or held in this process: the value is sent once and not kept, logged or echoed.
import type { DesktopApi } from '../../shared/contract';
import { requiredSessionId } from '../../shared/desktop-state';
import { requiredString } from '../../shared/scm-input';
import { MAX_SECRET_LENGTH, SECRET_REQUEST_ID } from '../../shared/secret-slots';
import type { DirectContext } from './context.ts';

const MAX_REQUEST_ID_LENGTH = 120;
const MAX_TAKEOVER_ID_LENGTH = 200;

export function createTakeoverApi(ctx: DirectContext): Pick<DesktopApi, 'provideSecretInput' | 'takeoverReady'> {
  return {
    provideSecretInput: async (requestId: string, value: string): Promise<boolean> => {
      const id = requiredString(requestId, 'secret request id', MAX_REQUEST_ID_LENGTH);
      const secret = typeof value === 'string' ? value : '';
      // An id the runtime did not mint, or an empty or oversized value, is not taken (and is not sent).
      if (!SECRET_REQUEST_ID.test(id) || !secret || secret.length > MAX_SECRET_LENGTH) return false;
      await ctx.call('approval/provideSecret', { requestId: id, secret });
      return true;
    },
    takeoverReady: async (sessionId: string, id: string): Promise<boolean> => {
      const reply = (await ctx.call('takeover/ready', {
        sessionId: requiredSessionId(sessionId),
        takeoverId: requiredString(id, 'takeover id', MAX_TAKEOVER_ID_LENGTH),
      })) as { ready?: unknown } | null;
      return reply?.ready === true;
    },
  };
}
