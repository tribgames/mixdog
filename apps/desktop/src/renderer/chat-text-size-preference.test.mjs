import test from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'mixdog.desktop.chat-text-size.v1';
const storage = new Map();
const rootStyle = new Map();
const target = new EventTarget();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  Event,
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
};
globalThis.document = {
  documentElement: { style: { setProperty: (name, value) => rootStyle.set(name, value) } },
};

const { getChatTextScale, getChatTextSize, installChatTextSize, setChatTextSize } = await import(
  './chat-text-size-preference.ts'
);

test('chat text size defaults to scale 1 with nothing stored', () => {
  assert.equal(getChatTextSize(), 'default');
  assert.equal(getChatTextScale(), 1);
});

test('an invalid stored value falls back to the default size', () => {
  storage.set(KEY, 'huge');
  assert.equal(getChatTextSize(), 'default');
  assert.equal(getChatTextScale(), 1);
});

test('set persists the size per device and get reads it back', () => {
  for (const [size, scale] of [
    ['small', 0.9],
    ['large', 1.15],
    ['extra-large', 1.3],
    ['default', 1],
  ]) {
    assert.equal(setChatTextSize(size), true);
    assert.equal(storage.get(KEY), size);
    assert.equal(getChatTextSize(), size);
    assert.equal(getChatTextScale(), scale);
  }
});

test('a refused write keeps the new pick over the older stored value', () => {
  storage.set(KEY, 'default');
  const setItem = window.localStorage.setItem;
  window.localStorage.setItem = () => {
    throw new Error('quota');
  };
  try {
    assert.equal(setChatTextSize('extra-large'), false);
    assert.equal(getChatTextSize(), 'extra-large');
    assert.equal(getChatTextScale(), 1.3);
  } finally {
    window.localStorage.setItem = setItem;
  }
  assert.equal(setChatTextSize('default'), true);
  assert.equal(getChatTextSize(), 'default');
});

test('install applies the stored scale to the root and follows every change live', () => {
  storage.set(KEY, 'large');
  const remove = installChatTextSize();
  assert.equal(rootStyle.get('--mx-chat-scale'), '1.15');
  setChatTextSize('extra-large');
  assert.equal(rootStyle.get('--mx-chat-scale'), '1.3');
  remove();
  setChatTextSize('small');
  assert.equal(rootStyle.get('--mx-chat-scale'), '1.3');
});
