import assert from 'node:assert/strict';
import test from 'node:test';
import { readGithubStarred, rememberGithubStarred } from './github-star-storage.ts';

test('confirmed stars survive a fresh reader and negative results do not erase them', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const saved = new Map();
  const localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
    assert.equal(readGithubStarred(), false);
    rememberGithubStarred(false);
    assert.equal(saved.size, 0);
    assert.equal(rememberGithubStarred(true), true);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { ...localStorage } } });
    assert.equal(readGithubStarred(), true);
    rememberGithubStarred(false);
    assert.equal(readGithubStarred(), true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
});

test('unavailable storage does not break status reads or successful stars', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { get localStorage() { throw new Error('Storage unavailable'); } },
    });
    assert.equal(readGithubStarred(), false);
    assert.equal(rememberGithubStarred(true), true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
});
