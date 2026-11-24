// The engine lane's `input/batch` and `ref/call` over pages of a real guest-state store, called the way the core calls
// them. A ref call reaches its element through the page's DOM refs (`evaluate`) unless the test gives the page
// accessibility refs.
import { browserDocumentId } from '../../browser/host-state.ts';
import { registerInputBatch } from './input-batch.ts';
import { registerRefCall } from './ref-call.ts';

export function engineLane({ state, cdp = {}, evaluate = async () => ({ ok: true, value: {} }) }) {
  const handlers = new Map();
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const guests = new Map();
  const ctx = {
    page: (pageId) => {
      const guest = guests.get(pageId);
      return guest ? { guest, state: state.for(guest) } : undefined;
    },
    session: () => undefined,
    cdp: { guestDebugger: async () => ({}), call: async () => ({}), releaseObject() {}, ...cdp },
    events: { flush: () => undefined, facts: (pageId) => ({ pageId }) },
    redactKnown: (_pageId, text) => text,
    isEngineMode: () => true,
  };
  registerInputBatch(connection, ctx);
  registerRefCall(connection, ctx, { evaluate });
  const pageId = (guest) => {
    const id = state.pageId(guest);
    guests.set(id, guest);
    return id;
  };
  const signal = () => new AbortController().signal;
  return {
    input: (guest, steps, fields = {}) =>
      handlers.get('host/browser/input/batch')(
        {
          pageId: pageId(guest),
          steps,
          stopOnDialog: true,
          timeoutMs: 0,
          expect: { documentId: browserDocumentId(state, guest) },
          ...fields,
        },
        signal()
      ),
    refCall: (guest, fields = {}) => {
      const record = state.for(guest);
      if (!record.accessibilityRefs) record.refSet = { snapshotId: 's1' };
      return handlers.get('host/browser/ref/call')(
        { pageId: pageId(guest), snapshotId: 's1', ref: 'e1', functionDeclaration: 'function() {}', ...fields },
        signal()
      );
    },
  };
}
