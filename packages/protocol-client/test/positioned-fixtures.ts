import { sessionReducer, type SessionFold } from '../src/session-state.ts';

export const pos = (id: string) => `h1:0:${id}`;
export const end = { kind: 'end' };
export const cont = (position: string) => ({ kind: 'continuation', position });
export const at = (s: SessionFold, method: string, params: Record<string, unknown>) =>
  sessionReducer.apply(s, { method, params: { threadId: 't', ...params } } as never);
