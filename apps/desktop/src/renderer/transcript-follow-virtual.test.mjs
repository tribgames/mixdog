// Reader intent vs the virtual timeline's bottom anchor, driven by the REAL
// virtual core.
//
// Both reported rollbacks are reproduced here as frame loops over
// @tanstack/virtual-core with the follow hook's grammar wired around it
// (wheel -> release -> anchor, scroll event, rAF, React commit, row
// measurement, content-observer delivery):
//
//   1. streaming — inside the core's 80px end band every append re-pinned the
//      bottom, so a wheel notch smaller than the tail's growth never left it.
//   2. idle — a row ABOVE the reading offset resolving from its 60px estimate
//      grows the transcript by hundreds of px; the old after-the-fact bottom
//      rule read that growth as "the reader is still at the tail" and wrote
//      the viewport back down.
//
// The predicates under test are imported from the hook; the surrounding React
// wiring (immediate anchor release, attach-only first observer delivery) is
// modelled frame by frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Virtualizer } from '@tanstack/virtual-core';
import { BOTTOM_THRESHOLD_PX, grewWhileAtBottom } from './use-transcript-follow.ts';

const VIEW = 800;
const ESTIMATE = 60;
const SPACER = 24;
const FRAME_MS = 16;
const GESTURE_WINDOW_MS = 250;
const WHEEL_NOTCH_PX = 100;

function createTranscript({ count = 300, rowHeight = (i) => 260 + (i % 7) * 190 } = {}) {
  let now = 0;
  const frames = [];
  const fakeWindow = {
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => {},
  };
  let offsetCb = null;
  let pendingScroll = false;
  const el = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: VIEW,
    window: fakeWindow,
    addEventListener() {},
    removeEventListener() {},
    scrollTo({ top }) { setTop(top); },
  };
  const maxScroll = () => Math.max(0, el.scrollHeight - VIEW);
  const distanceFromBottom = () => el.scrollHeight - el.clientHeight - el.scrollTop;
  const canScroll = () => el.scrollHeight - el.clientHeight > 1;
  function setTop(top) {
    const next = Math.max(0, Math.min(maxScroll(), top));
    if (next === el.scrollTop) return;
    el.scrollTop = next;
    pendingScroll = true;
  }

  // ---- follow hook state (use-transcript-follow.ts) ----
  const hook = {
    following: true,
    lastTop: 0,
    lastScrollHeight: 0,
    lastDistance: 0,
    programmatic: [],
    gestureAt: -Infinity,
    attachDelivery: true,
    writes: [],
  };
  let reactPending = false;
  let anchorProp = true;
  let anchorOverride = null;
  let followFlippedTrue = false;
  const events = [];
  const markGesture = () => { hook.gestureAt = now; };
  const hasGesture = () => now - hook.gestureAt < GESTURE_WINDOW_MS;
  const markProgrammatic = (top, intended) => {
    hook.programmatic = hook.programmatic
      .filter((entry) => now - entry.time < 1_500)
      .concat([{ top: Math.round(top), time: now }, { top: Math.round(intended), time: now }])
      .slice(-12);
  };
  const isProgrammatic = () => {
    hook.programmatic = hook.programmatic.filter((entry) => now - entry.time < 1_500);
    const top = Math.round(el.scrollTop);
    return hook.programmatic.some((entry) => Math.abs(top - entry.top) < 2);
  };

  const sizes = new Map();
  const size = (index) => sizes.get(index) ?? rowHeight(index);
  const v = new Virtualizer({
    count,
    getScrollElement: () => el,
    estimateSize: () => ESTIMATE,
    getItemKey: (index) => `row:${index}`,
    observeElementRect: (_instance, cb) => { cb({ width: 600, height: VIEW }); return () => {}; },
    observeElementOffset: (_instance, cb) => { offsetCb = cb; return () => {}; },
    scrollToFn: (offset, options, instance) => {
      el.scrollHeight = instance.getTotalSize();
      const intended = offset + (options?.adjustments ?? 0);
      setTop(intended);
      markProgrammatic(el.scrollTop, intended);
      events.push(`core write -> ${Math.round(el.scrollTop)}`);
    },
    overscan: 50,
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
    paddingEnd: SPACER,
  });
  v.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0) + (instance.scrollAdjustments ?? 0);
  v._didMount();
  v._willUpdate();

  // TranscriptList's imperative anchor control: applied in the SAME task as
  // the follow decision, and held across renders until React catches up.
  function setAnchorBottom(bottom) {
    anchorOverride = bottom;
    const anchorTo = bottom ? 'end' : 'start';
    if (v.options.anchorTo === anchorTo) return;
    v.setOptions({ ...v.options, anchorTo, followOnAppend: bottom });
  }
  function publish(next) {
    if (hook.following !== next) events.push(`follow=${next}`);
    hook.following = next;
    setAnchorBottom(next);
    if (next) followFlippedTrue = true;
    reactPending = true;
  }
  function scrollToBottomHook(tag) {
    if (!hook.following) return;
    if (distanceFromBottom() < 2) return;
    hook.writes.push(`${tag} -> bottom (was ${Math.round(el.scrollTop)})`);
    events.push(`HOOK WRITE (${tag})`);
    setTop(el.scrollHeight);
  }
  function handleScroll() {
    const previousTop = hook.lastTop;
    hook.lastTop = el.scrollTop;
    hook.lastScrollHeight = el.scrollHeight;
    hook.lastDistance = distanceFromBottom();
    if (!hook.following) {
      if (isProgrammatic()) return;
      const distance = distanceFromBottom();
      const band = Math.max(32, Math.round(el.clientHeight * 0.12));
      if (!canScroll() || distance < BOTTOM_THRESHOLD_PX
        || (el.scrollTop > previousTop && distance <= band)) {
        publish(true);
      }
      return;
    }
    if (!hasGesture()) return;
    if (previousTop - el.scrollTop > 1) publish(false);
  }
  function observerDelivery() {
    const growth = el.scrollHeight - hook.lastScrollHeight;
    hook.lastScrollHeight = el.scrollHeight;
    const distance = distanceFromBottom();
    const distanceBefore = hook.lastDistance;
    hook.lastDistance = distance;
    if (!canScroll()) {
      if (!hook.following) publish(true);
      return;
    }
    if (hook.attachDelivery) {
      hook.attachDelivery = false;
      return;
    }
    if (!hook.following) {
      if (isProgrammatic()) return;
      if (hasGesture()) return;
      if (grewWhileAtBottom({ distanceBefore, growth })) {
        events.push(`observer re-arm distance=${Math.round(distanceBefore)} growth=${Math.round(growth)}`);
        publish(true);
        scrollToBottomHook('observer');
      }
      return;
    }
    if (distance < BOTTOM_THRESHOLD_PX) return;
    scrollToBottomHook('observer(following)');
  }
  function reactCommit() {
    reactPending = false;
    const nextProp = hook.following;
    const propChanged = nextProp !== anchorProp;
    anchorProp = nextProp;
    if (anchorOverride === anchorProp) anchorOverride = null;
    const effective = anchorOverride ?? anchorProp;
    v.setOptions({
      ...v.options,
      anchorTo: effective ? 'end' : 'start',
      followOnAppend: effective,
    });
    v._willUpdate();
    if (propChanged) {
      // TranscriptList's overscan effect re-runs on the anchor prop.
      fakeWindow.requestAnimationFrame(() => {
        if (effective) v.scrollToEnd();
        fakeWindow.requestAnimationFrame(() => { if (effective) v.scrollToEnd(); });
      });
    }
    if (followFlippedTrue) {
      followFlippedTrue = false;
      // Conversation's re-pin effect on `following`.
      if (hook.following && distanceFromBottom() > BOTTOM_THRESHOLD_PX) v.scrollToEnd();
    }
    // The content observer is re-created by the follow effect: its first
    // delivery may only seed the baselines.
    hook.attachDelivery = true;
    hook.lastScrollHeight = el.scrollHeight;
    hook.lastDistance = distanceFromBottom();
  }

  const measured = new Set();
  function measureRendered() {
    let did = false;
    for (const item of v.getVirtualItems()) {
      if (measured.has(item.index)) continue;
      measured.add(item.index);
      v.resizeItem(item.index, size(item.index));
      el.scrollHeight = v.getTotalSize();
      did = true;
    }
    return did;
  }
  function growTail(delta) {
    if (!delta) return false;
    const last = count - 1;
    sizes.set(last, size(last) + delta);
    v.resizeItem(last, size(last));
    el.scrollHeight = v.getTotalSize();
    return true;
  }
  // A row ABOVE the reading offset settling from its estimate — a tool card
  // promoting to its real height, a font or media landing late. The core holds
  // the reading position by writing the growth into scrollTop.
  function growAbove(delta) {
    if (!delta) return false;
    const offset = (v.scrollOffset ?? 0) + (v.scrollAdjustments ?? 0);
    const above = v.getVirtualItems().filter((row) => row.end <= offset);
    const item = above[above.length - 1];
    if (!item) return false;
    sizes.set(item.index, size(item.index) + delta);
    v.resizeItem(item.index, size(item.index));
    el.scrollHeight = v.getTotalSize();
    return true;
  }

  // Settle the mount the way the first frames do, then take the idle state.
  for (let i = 0; i < 60; i += 1) {
    const did = measureRendered();
    if (pendingScroll) { pendingScroll = false; offsetCb?.(el.scrollTop, false); }
    frames.splice(0).forEach((cb) => cb());
    if (!did) break;
  }
  el.scrollHeight = v.getTotalSize();
  hook.lastTop = el.scrollTop;
  hook.lastScrollHeight = el.scrollHeight;
  hook.lastDistance = distanceFromBottom();
  hook.programmatic = [];
  hook.writes.length = 0;
  hook.attachDelivery = false;
  reactPending = false;

  // Chrome animates a wheel notch over several frames as a RELATIVE remainder,
  // so a programmatic write inside the animation moves the whole ramp with it.
  let wheelRemaining = 0;
  let commitPending = false;
  function frame({ wheel = 0, tail = 0, above = 0 } = {}) {
    now += FRAME_MS;
    events.length = 0;
    const before = el.scrollTop;
    // React commits the previous frame's state: the anchor prop, the timeline
    // effects, and the observer re-attach all land one frame after the intent
    // that produced them.
    if (commitPending) { commitPending = false; reactCommit(); }
    if (wheel) {
      markGesture();
      wheelRemaining += wheel;
      // Wheel rule: an upward wheel releases immediately, however small.
      if (wheel < 0) publish(false);
    }
    if (wheelRemaining) {
      const ramp = wheelRemaining * 0.35;
      const applied = Math.abs(ramp) < 1 ? wheelRemaining : ramp;
      wheelRemaining -= applied;
      setTop(el.scrollTop + applied);
    }
    if (pendingScroll) { pendingScroll = false; offsetCb?.(el.scrollTop, true); handleScroll(); }
    frames.splice(0).forEach((cb) => cb());
    const grew = [measureRendered(), growTail(tail), growAbove(above)].some(Boolean);
    el.scrollHeight = v.getTotalSize();
    if (grew || hook.attachDelivery) observerDelivery();
    if (pendingScroll) { pendingScroll = false; offsetCb?.(el.scrollTop, true); handleScroll(); }
    if (reactPending) { reactPending = false; commitPending = true; }
    return {
      before,
      top: el.scrollTop,
      net: el.scrollTop - before,
      distance: maxScroll() - el.scrollTop,
      following: hook.following,
      events: events.slice(),
    };
  }

  return {
    frame,
    hook,
    state: () => ({
      top: el.scrollTop,
      distance: maxScroll() - el.scrollTop,
      following: hook.following,
      anchorTo: v.options.anchorTo,
    }),
  };
}

test('an idle transcript keeps every wheel notch the reader spends', () => {
  const sim = createTranscript();
  const start = sim.state();
  assert.ok(start.distance < BOTTOM_THRESHOLD_PX, 'entry resolves at the tail');
  for (let i = 1; i <= 30; i += 1) {
    sim.frame({ wheel: i % 5 === 1 ? -WHEEL_NOTCH_PX : 0 });
  }
  const end = sim.state();
  assert.equal(end.following, false, 'the reader owns the viewport after wheeling up');
  assert.equal(end.anchorTo, 'start', 'the core anchor is released with the reader intent');
  assert.ok(end.distance > 5 * WHEEL_NOTCH_PX * 0.8,
    `six wheel notches must survive, got ${Math.round(end.distance)}px from the bottom`);
  assert.deepEqual(sim.hook.writes, [], 'the follow hook must not write during a reader gesture');
});

test('rows measured above the reading offset never drag an idle reader back', () => {
  const sim = createTranscript();
  sim.frame({ wheel: -WHEEL_NOTCH_PX });
  for (let i = 0; i < 12; i += 1) sim.frame();
  const parked = sim.state();
  assert.equal(parked.following, false);
  // Long after the gesture window closes, late measurements keep growing the
  // transcript ABOVE the reader (tool cards resolving from their estimate).
  // The core absorbs each one by writing scrollTop, so the reading position —
  // the distance from the bottom — must not move.
  for (let i = 0; i < 12; i += 1) {
    sim.frame({ above: 400 + i * 30 });
    sim.frame();
  }
  const end = sim.state();
  assert.equal(end.following, false, 'growth above the reader is not an arrival at the tail');
  assert.ok(end.top > parked.top, 'the core compensates growth above by moving the offset down');
  assert.ok(Math.abs(end.distance - parked.distance) < 2,
    `the reading position must stay still, moved ${Math.round(parked.distance - end.distance)}px`);
  assert.deepEqual(sim.hook.writes, []);
});

test('a streaming tail cannot out-grow the reader inside the core end band', () => {
  const sim = createTranscript();
  const start = sim.state();
  // One notch up while the tail grows faster than the notch: the old end
  // anchor rolled each frame back by the growth and the reader never left.
  const first = sim.frame({ wheel: -WHEEL_NOTCH_PX, tail: 30 });
  assert.ok(first.net <= -0.3 * WHEEL_NOTCH_PX,
    `the first frame of the gesture must keep its whole ramp, got ${Math.round(first.net)}px`);
  for (let i = 0; i < 20; i += 1) sim.frame({ tail: 30 });
  const end = sim.state();
  assert.equal(end.following, false, 'a streaming tail must not re-arm follow by itself');
  // The tail grows BELOW the reader, so the reader's own offset must carry the
  // full notch: an end anchor still armed for one frame ate part of it.
  assert.ok(end.top <= start.top - 0.95 * WHEEL_NOTCH_PX,
    `the reader's offset must keep the notch, lost ${Math.round(end.top - (start.top - WHEEL_NOTCH_PX))}px`);
  assert.ok(end.distance > WHEEL_NOTCH_PX,
    `the reader must keep gaining distance from a growing tail, got ${Math.round(end.distance)}px`);
  assert.deepEqual(sim.hook.writes, []);
});

test('an armed transcript still follows its growing tail', () => {
  const sim = createTranscript();
  for (let i = 0; i < 20; i += 1) sim.frame({ tail: 40 });
  const end = sim.state();
  assert.equal(end.following, true, 'nothing released follow');
  assert.ok(end.distance <= BOTTOM_THRESHOLD_PX,
    `the tail stays pinned, ${Math.round(end.distance)}px left below`);
});
