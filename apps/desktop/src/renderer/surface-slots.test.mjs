import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
});
const { placeFixedSurface, renderSurfaceRoot, unmountSurfaceRoot } = await import('./surface-slots.ts');

test('a fixed surface lands on its slot when the phone body is offset by a panned visual viewport', () => {
  const document = dom.window.document;
  const container = document.createElement('div');
  document.body.appendChild(container);
  // The phone body (position: fixed + transform) follows the visual viewport,
  // so it is the containing block and sits at the panned origin.
  document.body.getBoundingClientRect = () => ({ left: 12, top: 30, right: 424, bottom: 900, width: 412, height: 870 });
  const slot = { left: 12, top: 74, width: 412, height: 826 };

  document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  placeFixedSurface(container, slot);
  assert.deepEqual(
    [container.style.left, container.style.top, container.style.width, container.style.height],
    ['0px', '44px', '412px', '826px']
  );

  // Desktop: the viewport is the containing block, coordinates apply as-is.
  document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
  placeFixedSurface(container, slot);
  assert.deepEqual([container.style.left, container.style.top], ['12px', '74px']);
});

test('mid-slide, a phone surface sits on its settled slot and runs the sheet slide with it', () => {
  const view = dom.window;
  const document = view.document;
  document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  document.body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 375, bottom: 812, width: 375, height: 812 });
  const sheet = document.createElement('div');
  sheet.className = 'pane-side-dock';
  sheet.dataset.open = 'true';
  const slot = document.createElement('div');
  sheet.appendChild(slot);
  const container = document.createElement('div');
  document.body.append(sheet, container);
  // jsdom has no Web Animations or DOMMatrix: stand-ins with the shapes used.
  class KeyframeEffect {
    getKeyframes() {
      return [
        { offset: 0, transform: 'translateX(100%)' },
        { offset: 1, transform: 'none' },
      ];
    }
    getTiming() {
      return { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
    }
  }
  view.KeyframeEffect = KeyframeEffect;
  view.DOMMatrixReadOnly = class {
    constructor(transform) {
      this.m41 = Number(transform.split(',')[4]);
    }
  };
  const slide = {
    transitionProperty: 'transform',
    playState: 'running',
    startTime: 1000,
    effect: new KeyframeEffect(),
  };
  sheet.getAnimations = () => [slide];
  const copies = [];
  container.getAnimations = () => copies;
  container.animate = (keyframes, timing) => {
    const copy = { id: '', startTime: null, keyframes, timing, cancel() {} };
    copies.push(copy);
    return copy;
  };

  sheet.style.transform = 'matrix(1, 0, 0, 1, 120, 0)';
  placeFixedSurface(container, { left: 120, top: 0, width: 375, height: 812 }, slot);
  assert.deepEqual([container.style.left, container.style.width], ['0px', '375px']);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].startTime, 1000);
  assert.deepEqual(copies[0].timing, slide.effect.getTiming());
  assert.deepEqual(copies[0].keyframes, slide.effect.getKeyframes());

  // The next frame of the same slide moves nothing and starts no second copy.
  sheet.style.transform = 'matrix(1, 0, 0, 1, 40.0003, 0)';
  placeFixedSurface(container, { left: 40, top: 0, width: 375, height: 812 }, slot);
  assert.equal(container.style.left, '0px');
  assert.equal(copies.length, 1);

  // Settled: the slot's own rect.
  sheet.getAnimations = () => [];
  sheet.style.transform = 'none';
  placeFixedSurface(container, { left: 0, top: 0, width: 375, height: 812 }, slot);
  assert.equal(container.style.left, '0px');
  document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
  sheet.remove();
  container.remove();
});

test('a phone surface root renders from the next frame (newest element only); desktop at once', () => {
  const view = dom.window;
  const frames = new Map();
  let nextFrame = 0;
  view.requestAnimationFrame = (callback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  };
  view.cancelAnimationFrame = (handle) => frames.delete(handle);
  const runFrames = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  };
  const root = {
    renders: [],
    unmounted: false,
    render(element) {
      this.renders.push(element);
    },
    unmount() {
      this.unmounted = true;
    },
  };

  renderSurfaceRoot(root, 'desktop');
  assert.deepEqual(root.renders, ['desktop']);

  view.document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  renderSurfaceRoot(root, 'stale');
  renderSurfaceRoot(root, 'newest');
  assert.deepEqual(root.renders, ['desktop']);
  runFrames();
  assert.deepEqual(root.renders, ['desktop', 'newest']);

  // An unmount drops the render still queued for the root.
  renderSurfaceRoot(root, 'late');
  unmountSurfaceRoot(root);
  runFrames();
  assert.deepEqual(root.renders, ['desktop', 'newest']);
  assert.equal(root.unmounted, true);
  view.document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
});
