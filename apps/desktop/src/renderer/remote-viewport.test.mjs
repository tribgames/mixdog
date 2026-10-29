import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampView,
  containScale,
  fillScale,
  followPoint,
  initialView,
  OVERPAN_RETURN_MS,
  keyboardClosing,
  keyboardEvidence,
  maxViewScale,
  panView,
  pictureContains,
  pictureToStage,
  relaxView,
  REMOTE_VIEW_MAX_SCALE,
  rescaleView,
  sameAspect,
  stageToPicture,
  trackStage,
  viewBounds,
  viewReady,
  zoomView,
} from './remote-viewport.ts';

// A landscape PC on a portrait phone.
const pc = { picture: { width: 1920, height: 1080 }, stage: { width: 390, height: 700 } };
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);

test('the first view fills the height and starts at the left edge, panning sideways', () => {
  const view = initialView(pc);
  near(view.scale, 700 / 1080, 'the larger fit ratio');
  assert.equal(fillScale(pc), view.scale);
  assert.equal(view.y, 0, 'the height is filled exactly');
  assert.equal(view.x, 0, 'from the top-left corner');
  const right = panView(view, pc, -10_000, 0);
  near(right.x, 390 - 1920 * view.scale, 'pans as far as the right edge, no further');
  assert.equal(right.y, 0, 'no vertical room');
  assert.deepEqual(panView(right, pc, 10_000, 50), { ...view, y: 0 }, 'and back to the left edge');
  // A picture of the stage's own shape: fill and contain agree.
  assert.deepEqual(initialView({ picture: { width: 780, height: 1400 }, stage: { width: 390, height: 700 } }), {
    scale: 0.5,
    x: 0,
    y: 0,
  });
});

test('the minimum is the whole picture; an axis smaller than the stage is pinned to its centre', () => {
  const contain = containScale(pc);
  near(contain, 390 / 1920, 'contain fit');
  const out = zoomView(initialView(pc), pc, 0.01, { x: 100, y: 300 });
  assert.equal(out.scale, contain, 'a pinch never goes below it');
  const height = 1080 * contain;
  near(out.y, (700 - height) / 2, 'centred vertically');
  assert.equal(out.x, 0, 'the width fits exactly');
  // Panning cannot move a pinned axis.
  assert.deepEqual(panView(out, pc, 40, -40), out);
  assert.deepEqual(viewBounds(pc, contain).y, [out.y, out.y]);
});

test('the maximum is REMOTE_VIEW_MAX_SCALE stage px per picture unit, or the fill when deeper', () => {
  assert.equal(maxViewScale(pc), REMOTE_VIEW_MAX_SCALE);
  const deep = zoomView(initialView(pc), pc, 1_000, { x: 195, y: 350 });
  assert.equal(deep.scale, REMOTE_VIEW_MAX_SCALE);
  // A tiny picture fills past the cap: the fill is the floor of the maximum.
  const tiny = { picture: { width: 40, height: 30 }, stage: { width: 390, height: 700 } };
  assert.equal(maxViewScale(tiny), 700 / 30);
  assert.equal(initialView(tiny).scale, 700 / 30);
});

test('zoom keeps the picture point under the pivot, and the mapping round-trips', () => {
  const view = initialView(pc);
  const pivot = { x: 200, y: 300 };
  const under = stageToPicture(view, pivot);
  const zoomed = zoomView(view, pc, 2, pivot);
  const after = stageToPicture(zoomed, pivot);
  near(after.x, under.x, 'x stays');
  near(after.y, under.y, 'y stays');
  const back = pictureToStage(zoomed, after);
  near(back.x, pivot.x, 'round trip x');
  near(back.y, pivot.y, 'round trip y');
  assert.equal(pictureContains(pc, under), true);
  assert.equal(pictureContains(pc, { x: -1, y: 10 }), false);
  assert.equal(pictureContains(pc, { x: 1920, y: 10 }), false);
});

test('a bottom inset keeps the scale, moves nothing, and lets what is under it be brought up', () => {
  const contain = containScale(pc);
  const pinned = clampView({ scale: contain, x: 0, y: 0 }, pc);
  const keyboard = { ...pc, insets: { bottom: 400 } };
  assert.deepEqual(clampView(pinned, keyboard), pinned, 'the keyboard opening moves nothing');
  assert.equal(initialView(keyboard).scale, initialView(pc).scale, 'nor changes the fit');
  // Overpan: up far enough that the picture is centred in the 300 px left.
  const up = panView(pinned, keyboard, 0, -10_000);
  near(up.y, (300 - 1080 * contain) / 2, 'raised over the keyboard');
  // At the filled scale the bottom edge can reach the keyboard's top.
  const filled = initialView(keyboard);
  near(panView(filled, keyboard, 0, -10_000).y, 300 - 700, 'the bottom row above the keyboard');
  assert.equal(panView(filled, pc, 0, -10_000).y, 0, 'without it, no vertical room');

  // The keyboard closes: the view returns over OVERPAN_RETURN_MS, decelerating,
  // and lands exactly on the bounds.
  const distance = pinned.y - up.y;
  const at = (ms) => relaxView({ from: up, elapsedMs: ms }, pc);
  assert.equal(at(0).settled, false);
  near(at(0).view.y, up.y, 'starts where it was');
  near(at(OVERPAN_RETURN_MS / 2).view.y, pinned.y - distance / 4, 'halfway in time, three quarters of the way');
  const steps = [];
  for (let ms = 16; ms < OVERPAN_RETURN_MS; ms += 16) steps.push(at(ms).view.y - at(ms - 16).view.y);
  assert.ok(
    steps.every((step) => step > 0),
    'moving down each frame'
  );
  assert.ok(
    steps.every((step, i) => i === 0 || step < steps[i - 1]),
    'each frame slower than the last'
  );
  assert.equal(at(OVERPAN_RETURN_MS - 1).settled, false);
  assert.deepEqual(at(OVERPAN_RETURN_MS), { view: pinned, settled: true });
  assert.deepEqual(
    relaxView({ from: pinned, elapsedMs: 0 }, pc),
    { view: pinned, settled: true },
    'nothing to do inside'
  );
});

test('the stage track insets only on keyboard evidence, and clears the inset without it', () => {
  const full = { width: 390, height: 700, bottom: 0 };
  const open = trackStage(full, { width: 390, height: 380 }, true);
  assert.deepEqual(open, { width: 390, height: 700, bottom: 320 }, 'the same stage, inset');
  assert.deepEqual(trackStage(open, { width: 390, height: 360 }, true), { width: 390, height: 700, bottom: 340 });
  // No evidence: no inset, whatever came before; the shorter stage is a new layout.
  assert.deepEqual(trackStage(open, { width: 390, height: 380 }, false), { width: 390, height: 380, bottom: 0 });
  assert.deepEqual(trackStage(full, { width: 390, height: 520 }, false), { width: 390, height: 520, bottom: 0 });
  // A new width is a new layout even with a keyboard.
  assert.deepEqual(trackStage(open, { width: 700, height: 300 }, true), { width: 700, height: 300, bottom: 0 });
  assert.deepEqual(trackStage(null, { width: 390, height: 380 }, true), { width: 390, height: 380, bottom: 0 });
  // A keyboard over the page (VirtualKeyboard boundingRect): the stage keeps
  // its size and the covered part is the inset, on top of any shrink.
  assert.deepEqual(trackStage(full, { width: 390, height: 700 }, true, 300), { width: 390, height: 700, bottom: 300 });
  assert.deepEqual(trackStage(full, { width: 390, height: 600 }, true, 200), { width: 390, height: 700, bottom: 300 });
  assert.deepEqual(trackStage(full, { width: 390, height: 700 }, false, 300), { width: 390, height: 700, bottom: 0 });
});

test('keyboard evidence: a focused field and the visual viewport’s shrink, nothing else', () => {
  const visual = (height, width = 390) => ({ width, height });
  // A split-screen resize with nothing focused: no keyboard, the baseline follows.
  let seen = keyboardEvidence(null, { visual: visual(800), focused: false, closing: false });
  seen = keyboardEvidence(seen.baseline, { visual: visual(500), focused: false, closing: false });
  assert.equal(seen.open, false);
  assert.deepEqual(seen.baseline, visual(500), 'the layout’s own height');
  // Focus, then the keyboard slides up.
  seen = keyboardEvidence(seen.baseline, { visual: visual(500), focused: true, closing: false });
  assert.equal(seen.open, false, 'focused, not shrunk yet');
  // Any shrink while focused is the keyboard: no size floor.
  seen = keyboardEvidence(seen.baseline, { visual: visual(499), focused: true, closing: false });
  assert.equal(seen.open, true, 'the first pixel of it');
  seen = keyboardEvidence(seen.baseline, { visual: visual(380), focused: true, closing: false });
  assert.equal(seen.open, true);
  assert.deepEqual(seen.baseline, visual(500));
  // The VirtualKeyboard API's rectangle over the page is evidence on its own.
  assert.equal(
    keyboardEvidence(visual(800), { visual: visual(800), focused: false, closing: false, overlay: 280 }).open,
    true
  );
  assert.equal(
    keyboardEvidence(visual(800), { visual: visual(800), focused: true, closing: false, overlay: 0 }).open,
    false
  );
  // A shrink without focus is no keyboard.
  assert.equal(keyboardEvidence(visual(800), { visual: visual(400), focused: false, closing: false }).open, false);
  // Blurred: sliding away it still counts while closing; once back, or the time over, not.
  const sliding = keyboardEvidence(seen.baseline, { visual: visual(450), focused: false, closing: true });
  assert.equal(sliding.open, true);
  assert.equal(keyboardEvidence(sliding.baseline, { visual: visual(500), focused: false, closing: true }).open, false);
  assert.equal(keyboardEvidence(sliding.baseline, { visual: visual(450), focused: false, closing: false }).open, false);
  // Rotation starts over.
  const turned = keyboardEvidence(seen.baseline, { visual: visual(300, 800), focused: true, closing: false });
  assert.equal(turned.open, false);
  assert.deepEqual(turned.baseline, visual(300, 800));
});

test('a closing keyboard is followed by the visual viewport’s resizes, with no timer', () => {
  const baseline = { width: 390, height: 800 };
  const at = (height, width = 390) => ({ width, height });
  // Blurred with the viewport at 450: each resize that grows it, still short, keeps it closing.
  let closing = { height: 450 };
  closing = keyboardClosing(closing, at(600), baseline);
  assert.deepEqual(closing, { height: 600 });
  closing = keyboardClosing(closing, at(760), baseline);
  assert.deepEqual(closing, { height: 760 });
  // The resize that reaches the baseline ends it.
  assert.equal(keyboardClosing(closing, at(800), baseline), null);
  // So does one that does not grow it (the keyboard stopped, or came back).
  assert.equal(keyboardClosing({ height: 600 }, at(600), baseline), null);
  assert.equal(keyboardClosing({ height: 600 }, at(500), baseline), null);
  // A new width, or nothing closing, is no closing.
  assert.equal(keyboardClosing({ height: 600 }, at(700, 800), baseline), null);
  assert.equal(keyboardClosing(null, at(700), baseline), null);
  // While it closes the evidence holds the inset; once it ends, nothing does.
  assert.equal(keyboardEvidence(baseline, { visual: at(600), focused: false, closing: true }).open, true);
  assert.equal(keyboardEvidence(baseline, { visual: at(600), focused: false, closing: false }).open, false);
});

test('following a point centres it as far as the bounds allow; another size of the same picture keeps the view', () => {
  const view = initialView(pc);
  const followed = followPoint(view, pc, { x: 960, y: 540 });
  const center = pictureToStage(followed, { x: 960, y: 540 });
  near(center.x, 195, 'centred across');
  near(center.y, 350, 'and down');
  assert.equal(followPoint(view, pc, { x: 0, y: 0 }).x, 0, 'a corner stays clamped');

  const video = { width: 3840, height: 2160 };
  assert.equal(sameAspect(pc.picture, video), true);
  assert.equal(sameAspect(pc.picture, { width: 1920, height: 1200 }), false);
  const rescaled = rescaleView(followed, pc.picture, video);
  const point = pictureToStage(rescaled, { x: 1920, y: 1080 });
  near(point.x, center.x, 'the same spot on screen');
  near(point.y, center.y, 'the same spot on screen');
  assert.equal(viewReady({ picture: { width: 0, height: 1 }, stage: pc.stage }), false);
  assert.equal(viewReady(pc), true);
});
