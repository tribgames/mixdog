import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSnapshotCapture } from './snapshot-capture.ts';

function fixture({ childFailure = false } = {}) {
  const refs = new Map();
  const calls = [];
  const capture = createBrowserSnapshotCapture({
    evaluate: async () => ({
      url: 'https://example.test', title: 'Frames', text: 'Parent evidence',
      scrollY: 0, scrollHeight: 900, viewportHeight: 900, viewportWidth: 1280,
    }),
    cdp: {
      call: async (_guest, method, args, _signal, options) => {
        calls.push({ method, args, options });
        if (method === 'DOMSnapshot.captureSnapshot') return {
          strings: ['root-frame', 'child-frame'],
          documents: [{ frameId: 0 }, { frameId: 1 }],
        };
        if (method === 'Accessibility.getFullAXTree') {
          if (args.frameId && childFailure) throw new Error('child detached');
          return { nodes: args.frameId ? [
            { nodeId: '1', backendDOMNodeId: 20, role: { value: 'textbox' }, name: { value: 'Frame input' } },
            { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Child evidence' } },
          ] : [
            { nodeId: '1', backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Parent action' } },
          ] };
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'child-input' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: 'child value' } };
        throw new Error(`Unexpected ${method}`);
      },
      guestDebugger: async () => ({ sendCommand: async () => ({}) }),
    },
    diagnostics: () => ({ cdpSessions: new Map(), fault: '' }),
    visualGrounding: new Map(), accessibilityRefs: refs, refSets: new Map(),
    snapshotTextLimit: () => 2000, nextSnapshotId: () => 'p1-s1', maxElements: 160,
  });
  return { capture, refs, calls };
}

test('same-process frame controls and text are observed and refs retain their owning CDP session', async () => {
  const f = fixture();
  const guest = {};
  const snapshot = await f.capture.captureAccessibilitySnapshot(guest, {});
  assert.deepEqual(snapshot.elements.map(element => element.name), ['Parent action', 'Frame input']);
  assert.match(snapshot.text, /Parent evidence.*Child evidence/);
  const ref = snapshot.elements.find(element => element.name === 'Frame input').ref;
  assert.deepEqual(f.refs.get(guest).refs.get(ref), { backendNodeId: 20, sessionId: undefined });
  assert.deepEqual(await f.capture.callAccessibilityRef(guest, ref, 'function(){return this.value}', []),
    { handled: true, value: 'child value' });
  assert.equal(f.calls.find(call => call.method === 'DOM.resolveNode').args.backendNodeId, 20);
});

test('an unavailable child frame is reported without discarding the parent controls', async () => {
  const f = fixture({ childFailure: true });
  const snapshot = await f.capture.captureAccessibilitySnapshot({}, {});
  assert.deepEqual(snapshot.elements.map(element => element.name), ['Parent action']);
  assert.match(snapshot.warnings.join('\n'), /child detached/);
});
