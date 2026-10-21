// A group room's transcript while bots talk: the transient typing row and quiet
// passes must neither yank a reading user to the bottom nor shake the rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
  globals: {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useConversationFollowEffects, settledRowCount } = await import('./use-conversation-follow-effects.ts');
const { agentChatPlace, roomPassIsQuiet } = await import('./agent-chat-place.ts');
const { createTranscriptRowHeightStore, transcriptRowShape } = await import('./transcript-row-estimates.ts');

const speechItem = (id, speaker = 'rel') => ({
  kind: 'notice',
  id,
  text: id,
  room: { kind: 'speech', speaker, name: speaker },
});
const passItem = (id, failed) => ({ kind: 'notice', id, room: { kind: 'pass', speaker: 'bench', failed } });
const typingItem = (id, speaker = 'rel') => ({ kind: 'notice', id, room: { kind: 'typing', speaker, name: speaker } });
const userItem = (id) => ({ kind: 'user', id, text: id });
const part = (item) => ({ _tag: 'AssistantPart', key: item.id, turnKey: 't', item });

function mountFollow(items, onScrollToEnd, onArm) {
  const host = document.getElementById('root');
  const root = createRoot(host);
  const scrollToEndRef = { current: onScrollToEnd };
  const viewport = { current: null };
  const Probe = ({ settledItems }) => {
    useConversationFollowEffects({
      armFollow: onArm,
      following: false,
      scrollToEndRef,
      settledItems,
      transcriptRows: settledItems,
      transcriptSessionKey: 'room:1',
      viewport,
    });
    return null;
  };
  const render = (settledItems) => act(async () => root.render(React.createElement(Probe, { settledItems })));
  return { render, unmount: () => act(async () => root.unmount()), items };
}

test('the room typing row appearing and vanishing never re-arms follow or scrolls to the end', async () => {
  let scrolled = 0;
  let armed = 0;
  const base = [userItem('u1'), speechItem('s1')];
  const view = mountFollow(
    base,
    () => (scrolled += 1),
    () => (armed += 1)
  );
  await view.render(base);
  armed = 0;
  // Typing for the next speaker arrives, then (supervisor decision) vanishes,
  // another typing id appears, the speech lands while it is still present,
  // and the typing row goes away.
  await view.render([...base, typingItem('room-typing-a')]);
  await view.render(base);
  await view.render([...base, typingItem('room-typing-b', 'bench')]);
  await view.render([...base, speechItem('s2', 'bench'), typingItem('room-typing-b', 'bench')]);
  await view.render([...base, speechItem('s2', 'bench')]);
  await view.render([...base, speechItem('s2', 'bench'), passItem('p1')]);
  assert.equal(scrolled, 0, 'a reader scrolled up is not pulled to the bottom');
  assert.equal(armed, 0, 'follow is not re-armed by transient room rows');
  await view.unmount();
});

test('a real shrink of the settled transcript still returns to the live tail', async () => {
  let scrolled = 0;
  let armed = 0;
  const full = [userItem('u1'), speechItem('s1'), speechItem('s2'), typingItem('room-typing-a')];
  const view = mountFollow(
    full,
    () => (scrolled += 1),
    () => (armed += 1)
  );
  await view.render(full);
  armed = 0;
  await view.render([userItem('u1'), speechItem('s2')]);
  assert.equal(scrolled, 1);
  assert.equal(armed, 1);
  await view.unmount();
});

test('settledRowCount leaves out only the typing overlay', () => {
  assert.equal(settledRowCount([userItem('u'), typingItem('t'), passItem('p'), speechItem('s')]), 3);
});

test('a quiet pass neither breaks nor adds a bubble run; a failed pass still does', () => {
  assert.equal(roomPassIsQuiet(passItem('p')), true);
  assert.equal(roomPassIsQuiet(passItem('p', true)), false);
  const quiet = [part(speechItem('s1')), part(passItem('p')), part(speechItem('s2'))];
  assert.equal(agentChatPlace(quiet, 1), null);
  assert.equal(agentChatPlace(quiet, 0).last, false);
  assert.equal(agentChatPlace(quiet, 2).first, false);
  const failed = [part(speechItem('s1')), part(passItem('p', true)), part(speechItem('s2'))];
  assert.equal(agentChatPlace(failed, 1).side, 'aside');
  assert.equal(agentChatPlace(failed, 2).first, true);
});

test('a room typing bubble is estimated from typing bubbles, not from quiet passes or replies', () => {
  const typing = part(typingItem('t1'));
  const pass = part(passItem('p1'));
  const empty = part({ kind: 'notice', id: 'n', text: '' });
  assert.notEqual(transcriptRowShape(typing), transcriptRowShape(pass));
  assert.notEqual(transcriptRowShape(typing), transcriptRowShape(empty));
  const store = createTranscriptRowHeightStore(null);
  store.record(part(typingItem('t0')), 800, 40);
  store.record(part(passItem('p0', true)), 800, 24);
  assert.equal(store.estimate(typing, 800), 40);
});
