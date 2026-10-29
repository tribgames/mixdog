// A reader scrolled up while rows commit (a phone catching up after resume):
// the no-overflow re-arm must not read the viewport's layout inside the
// commit, where the freshly mounted rows force a full layout.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div><div id="viewport"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement'],
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useConversationFollowEffects } = await import('./use-conversation-follow-effects.ts');

// Frames run only when the test advances them: jsdom's visual mode fires
// requestAnimationFrame on a real 16ms timer, so a slow runner ran a frame
// between commits this test holds inside one frame.
const frames = new Map();
let lastFrameId = 0;
window.requestAnimationFrame = (callback) => {
  lastFrameId += 1;
  frames.set(lastFrameId, callback);
  return lastFrameId;
};
window.cancelAnimationFrame = (id) => {
  frames.delete(id);
};
const nextFrame = async () => {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(window.performance.now());
};

function mount(geometry) {
  const element = document.getElementById('viewport');
  let reads = 0;
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      get: () => {
        reads += 1;
        return geometry.content;
      },
    },
    clientHeight: {
      configurable: true,
      get: () => {
        reads += 1;
        return geometry.viewport;
      },
    },
  });
  let armed = 0;
  const viewport = { current: element };
  const scrollToEndRef = { current: () => {} };
  const armFollow = () => {
    armed += 1;
  };
  const Probe = ({ rows }) => {
    useConversationFollowEffects({
      armFollow,
      following: false,
      scrollToEndRef,
      settledItems: [],
      transcriptRows: rows,
      transcriptSessionKey: 's1',
      viewport,
    });
    return null;
  };
  const root = createRoot(document.getElementById('root'));
  return {
    render: (rows) => act(async () => root.render(React.createElement(Probe, { rows }))),
    reads: () => reads,
    armed: () => armed,
    unmount: () => act(async () => root.unmount()),
  };
}

test('a rows commit reads no viewport layout; the next frame re-arms follow once the content fits', async () => {
  const geometry = { content: 2_000, viewport: 800 };
  const view = mount(geometry);
  await view.render([1]);
  await act(nextFrame);
  const base = view.armed();
  const readsBefore = view.reads();
  // Three commits in one frame: none reads layout, one check follows them.
  await view.render([1, 2]);
  await view.render([1, 2, 3]);
  geometry.content = 600;
  await view.render([1]);
  assert.equal(view.reads(), readsBefore, 'no layout read inside the commits');
  await act(nextFrame);
  assert.equal(view.armed(), base + 1, 'the shrunk transcript that fits re-arms follow');
  assert.equal(view.reads() - readsBefore, 2, 'one viewport read for the three commits');
  // Content that overflows keeps the reader's position.
  geometry.content = 3_000;
  await view.render([1, 2, 3, 4]);
  await act(nextFrame);
  assert.equal(view.armed(), base + 1);
  await view.unmount();
});
