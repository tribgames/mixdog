// The followed end of a running turn in the real pane (test-support/session-switch-*), painted frame by painted frame:
// the tail stays where it sits above the composer through the turn's end, the island and the composer changing height
// and new rows arriving; follow lets go only when the reader scrolls away.
import assert from 'node:assert/strict';
import test from 'node:test';
import { launchSwitchBrowser, openSwitchPage } from './test-support/session-switch-rig.mjs';

let browser;
test.before(async () => {
  browser = await launchSwitchBrowser();
});
test.after(() => browser?.close());

/** Page script: `window.__jitter` samples the shown pane after each frame's layout (a ResizeObserver created after the
 *  pane's own), and logs the offsets its scroll events report and the heights written to its spacer. */
function installProbe() {
  const surface = () =>
    document.querySelector('.persistent-pane-surface:not([data-retained]):not([data-preparing])') ?? document;
  const parts = () => {
    const view = surface().querySelector('.transcript');
    return {
      view,
      dock: view.closest('.conversation').querySelector('.composer-region'),
      spacer: view.querySelector('.transcript-virtual-space'),
    };
  };
  const tenth = (value) => Math.round(value * 10) / 10;
  const sample = () => {
    const { view, dock } = parts();
    let last = null;
    for (const row of view.querySelectorAll('.transcript-virtual-row')) {
      if (row.getBoundingClientRect().height > 0 && (!last || Number(row.dataset.index) > Number(last.dataset.index)))
        last = row;
    }
    const jump = surface().querySelector('.jump-to-latest');
    return {
      client: view.clientHeight,
      top: tenth(view.scrollTop),
      // The painted tail's distance above the dock's top edge.
      tail: last ? tenth(dock.getBoundingClientRect().top - last.getBoundingClientRect().bottom) : null,
      following: view.dataset.following === 'true',
      jump: Boolean(jump) && jump.getAttribute('aria-hidden') !== 'true',
      end: tenth(view.scrollHeight - view.clientHeight - view.scrollTop),
    };
  };
  const log = { scrolls: [], spacer: [] };
  let watched = null;
  const watch = () => {
    const { view, spacer } = parts();
    if (watched === view) return;
    watched = view;
    let last = view.scrollTop;
    view.addEventListener(
      'scroll',
      () => {
        log.scrolls.push(tenth(view.scrollTop - last));
        last = view.scrollTop;
      },
      { passive: true }
    );
    new MutationObserver((records) => {
      // Each record holds the height before its write; the last write is the current one.
      for (const [at, record] of records.entries()) {
        if (at > 0)
          log.spacer.push(Number.parseFloat(/height:\s*([\d.]+)px/.exec(record.oldValue ?? '')?.[1] ?? 'NaN'));
      }
      log.spacer.push(Number.parseFloat(spacer.style.height));
    }).observe(spacer, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  };
  /** `count` painted frames, `act` run in the first one's animation callback. */
  const paint = (count, act = () => {}) =>
    new Promise((done) => {
      const out = [];
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-20px;top:0;width:1px;height:1px';
      document.body.append(probe);
      let frame = 0;
      const observer = new ResizeObserver(() => {
        if (frame > 0) out.push(sample());
      });
      observer.observe(probe);
      const tick = () => {
        frame += 1;
        if (frame === 1) act(window.rig);
        probe.style.width = `${(frame % 2) + 1}px`;
        if (frame < count) requestAnimationFrame(tick);
        else
          requestAnimationFrame(() => {
            observer.disconnect();
            probe.remove();
            done(out);
          });
      };
      requestAnimationFrame(tick);
    });
  window.__jitter = {
    sample,
    paint,
    log,
    watch,
    reset() {
      log.scrolls.length = 0;
      log.spacer.length = 0;
    },
  };
}

/** The deepest a written spacer height fell below a height written after it: a spacer that shrank first and grew back. */
function spacerDip(heights) {
  let dip = 0;
  for (let at = 0; at < heights.length; at += 1) {
    const later = Math.max(...heights.slice(at + 1));
    if (Number.isFinite(later)) dip = Math.max(dip, Math.min(later, heights[at - 1] ?? later) - heights[at]);
  }
  return Math.round(dip);
}

/** How far the painted tail strayed from where it sat before the change, across `frames`. */
function tailDrift(frames, rest) {
  return Math.max(0, ...frames.filter((frame) => frame.tail !== null).map((frame) => Math.abs(frame.tail - rest)));
}

async function streamingPane(t) {
  const p = await openSwitchPage(browser);
  t.after(async () => {
    const { errors } = p;
    await p.page.close();
    assert.deepEqual(errors, []);
  });
  await p.act(() => {
    window.rig.core.seed('A', 30, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(installProbe);
  await p.act(() => {
    window.rig.core.prompt('A');
    window.rig.core.stream('A', 'The reply starts streaming with a first paragraph of words. ');
  });
  await p.run(() => window.__jitter.watch());
  const rest = await p.run(() => window.__jitter.sample());
  assert.equal(rest.following, true, 'the pane follows the running turn');
  return { p, rest };
}

test('a turn that ends hands its live band to its footer without the spacer shrinking first or the tail moving', async (t) => {
  const problems = [];
  for (const changes of [false, true]) {
    const { p, rest } = await streamingPane(t);
    await p.run(() => window.__jitter.paint(6, (rig) => rig.core.stream('A', 'to the end of it.')));
    if (changes) await p.run(() => window.rig.core.changes('A-u31', ['src/app.ts', 'src/list.ts']));
    const before = await p.run(() => window.__jitter.sample());
    await p.run(() => window.__jitter.reset());
    const frames = await p.run(() =>
      window.__jitter.paint(24, (rig) => {
        rig.core.reply('A');
        rig.core.end('A');
      })
    );
    const log = await p.run(() => window.__jitter.log);
    const label = changes ? 'with a changes card' : 'with its footer';
    const metrics = {
      spacerDip: spacerDip(log.spacer),
      upwardScrolls: log.scrolls.filter((delta) => delta < 0),
      tailDrift: tailDrift(frames, before.tail),
      following: frames.every((frame) => frame.following),
    };
    t.diagnostic(`turn end ${label}: ${JSON.stringify(metrics)}`);
    if (metrics.spacerDip > 0) problems.push(`${label}: the spacer shrank ${metrics.spacerDip}px before the footer`);
    if (metrics.upwardScrolls.length > 0) problems.push(`${label}: the view was clamped up`);
    if (metrics.tailDrift > 0.5) problems.push(`${label}: the tail moved ${metrics.tailDrift}px`);
    if (!metrics.following || Math.abs(frames.at(-1).end) > 1) problems.push(`${label}: the end was not kept`);
    assert.equal(rest.following, true);
  }
  assert.deepEqual(problems, []);
});

/** What a dock change did to the transcript, and what it should not have done. */
function judgeDockChange(t, label, frames, rest, problems, upwardScrolls = []) {
  const metrics = {
    viewportHeights: [...new Set(frames.map((frame) => frame.client))],
    tailDrift: tailDrift(frames, rest.tail),
    upwardScrolls,
    following: frames.every((frame) => frame.following),
  };
  t.diagnostic(`${label}: ${JSON.stringify(metrics)}`);
  if (metrics.viewportHeights.join() !== String(rest.client)) problems.push(`${label}: the viewport changed height`);
  if (metrics.tailDrift > 0.5) problems.push(`${label}: the tail left the dock by ${metrics.tailDrift}px`);
  if (!metrics.following) problems.push(`${label}: follow was lost`);
}

test("the island and the composer changing height never resize the transcript's viewport, and the tail rides on the dock", async (t) => {
  const { p, rest } = await streamingPane(t);
  const problems = [];
  const cases = [
    ['an approval opens in the island', (rig) => rig.core.ask('A', 'approval')],
    ['the approval closes', (rig) => rig.core.answer('A')],
  ];
  for (const [label, act] of cases) {
    await p.run(() => window.__jitter.reset());
    const frames = await p.run(
      (source) => window.__jitter.paint(30, (rig) => new Function('rig', `return (${source})(rig)`)(rig)),
      act.toString()
    );
    judgeDockChange(t, label, frames, rest, problems);
  }
  // The composer grows a line at a time and shrinks back as the text goes, a reply streaming meanwhile.
  await p.page.focus('form.composer textarea');
  for (const [label, keys] of [
    ['the composer grows', ['a', 'Shift+Enter', 'b', 'Shift+Enter', 'c', 'Shift+Enter', 'd']],
    ['the composer shrinks', ['Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace']],
  ]) {
    await p.run(() => window.__jitter.reset());
    const painted = p.run(() => window.__jitter.paint(40));
    for (const key of keys) {
      const [modifier, name] = key.includes('+') ? key.split('+') : [null, key];
      if (modifier) await p.page.keyboard.down(modifier);
      await p.page.keyboard.press(name);
      if (modifier) await p.page.keyboard.up(modifier);
      await p.run(() => window.rig.core.stream('A', 'and a few more words '));
    }
    const frames = await painted;
    const { scrolls } = await p.run(() => window.__jitter.log);
    judgeDockChange(
      t,
      label,
      frames,
      rest,
      problems,
      scrolls.filter((delta) => delta < 0)
    );
  }
  assert.deepEqual(problems, []);
});

test('rows that arrive while the turn runs are written at their size: the spacer is not corrected after them', async (t) => {
  const { p } = await streamingPane(t);
  let corrections = 0;
  const sizes = [];
  for (let k = 0; k < 6; k += 1) {
    await p.run(() => window.__jitter.reset());
    await p.run(
      (k) => window.__jitter.paint(8, (rig) => rig.core.tool('A', `A-live${k}`, { done: false, name: 'grep' })),
      k
    );
    const { spacer } = await p.run(() => window.__jitter.log);
    // One height for the row's arrival; any other is the list correcting what it first wrote.
    corrections += Math.max(0, new Set(spacer).size - 1);
    sizes.push(spacer);
  }
  t.diagnostic(`new live rows: ${JSON.stringify({ corrections, spacerWrites: sizes })}`);
  assert.equal(corrections, 0, 'a new row was first written at a size it does not have');
});

test('follow lets go only when the reader scrolls away: not for a one-pixel wheel tick, a click, or a press on the padding', async (t) => {
  const { p } = await streamingPane(t);
  const problems = [];
  const streamOn = (repeat = 4) =>
    p.run(
      (repeat) =>
        window.__jitter.paint(20, (rig) =>
          rig.core.stream('A', `${'more words of the streaming reply '.repeat(repeat)}\n\n`)
        ),
      repeat
    );
  // Each case starts at the followed end.
  const rearm = async () => {
    await p.run(() => document.querySelector('.persistent-pane-surface:not([data-retained]) .jump-to-latest')?.click());
    await streamOn(1);
  };
  // A one-pixel tick toward older rows at the end.
  await p.run(() => {
    const log = document.querySelector('.persistent-pane-surface:not([data-retained]) .transcript');
    log.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
    log.scrollTop -= 1;
  });
  const tick = (await streamOn()).at(-1);
  t.diagnostic(`one-pixel wheel tick: ${JSON.stringify(tick)}`);
  if (!tick.following || Math.abs(tick.end) > 1) problems.push('a one-pixel tick let go of the end');
  await rearm();

  // A click on a reply's words, its pointer trembling a pixel.
  const word = await p.run(() => {
    const view = document.querySelector('.persistent-pane-surface:not([data-retained]) .transcript');
    const box = view.getBoundingClientRect();
    const rows = [...view.querySelectorAll('.transcript-virtual-row-content[data-tag="AssistantPart"] .markdown p')];
    const shown = rows.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top > box.top + 60 && rect.bottom < box.top + box.height / 2;
    });
    const range = document.createRange();
    range.selectNodeContents(shown.at(-1).firstChild);
    const line = range.getClientRects()[0];
    return { x: line.left + 30, y: line.top + line.height / 2 };
  });
  await p.page.mouse.move(word.x, word.y);
  await p.page.mouse.down();
  await p.page.mouse.move(word.x + 1, word.y);
  const clicked = await streamOn();
  await p.page.mouse.up();
  const click = {
    following: clicked.every((frame) => frame.following),
    jump: clicked.some((frame) => frame.jump),
    end: clicked.at(-1).end,
  };
  t.diagnostic(`a trembling click: ${JSON.stringify(click)}`);
  if (!click.following || click.jump || Math.abs(click.end) > 1) problems.push('a click held the end');
  await p.run(() => document.getSelection().removeAllRanges());
  await rearm();

  // A drag that selects words: the end is not written under them, and follow says so as the jump control does.
  await p.page.mouse.move(word.x, word.y);
  await p.page.mouse.down();
  await p.page.mouse.move(word.x + 120, word.y, { steps: 6 });
  await p.page.mouse.up();
  const held = await streamOn();
  const outOfStep = held.filter((frame) => frame.following && frame.jump).length;
  t.diagnostic(`a selection held: ${JSON.stringify({ outOfStep, last: held.at(-1) })}`);
  if (outOfStep > 0) problems.push(`follow and the jump control disagree in ${outOfStep} frames of a held selection`);
  if (held.at(-1).following || !(held.at(-1).end > 1)) problems.push('a held selection kept the end');
  await p.run(() => document.getSelection().removeAllRanges());
  const released = (await streamOn(2)).at(-1);
  if (!released.following || Math.abs(released.end) > 1)
    problems.push('the collapsed selection did not give the end back');
  await rearm();

  // A press on the transcript's own padding (the room it gives a session rail beside it) held while the approval
  // closes and the end moves under it.
  await p.run(() => window.__jitter.paint(30, (rig) => rig.core.ask('A', 'approval')));
  const pad = await p.run(() => {
    const view = document.querySelector('.persistent-pane-surface:not([data-retained]) .transcript');
    view.style.paddingLeft = '60px';
    const box = view.getBoundingClientRect();
    return {
      x: box.left + 20,
      y: box.top + 80,
      onRoot: document.elementFromPoint(box.left + 20, box.top + 80) === view,
    };
  });
  assert.ok(pad.onRoot, 'the press lands on the transcript itself');
  await streamOn(1);
  await p.page.mouse.move(pad.x, pad.y);
  await p.page.mouse.down();
  const pressed = await p.run(() => window.__jitter.paint(30, (rig) => rig.core.answer('A')));
  await p.page.mouse.up();
  t.diagnostic(`a press on the padding: ${JSON.stringify(pressed.at(-1))}`);
  if (!pressed.every((frame) => frame.following)) problems.push('a press on the padding let a clamp release follow');
  await rearm();

  // The reader's own wheel up does let go.
  await p.run(() => {
    const log = document.querySelector('.persistent-pane-surface:not([data-retained]) .transcript');
    log.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
    log.scrollTop -= 240;
  });
  const away = (await streamOn()).at(-1);
  t.diagnostic(`a wheel up: ${JSON.stringify(away)}`);
  if (away.following || !(away.end > 100)) problems.push("the reader's wheel up did not let go of the end");
  assert.deepEqual(problems, []);
});

// ───────────────────────────── a reader's place under the dock ─────────────────────────────

/** A fresh page whose errors fail the case. */
async function quietPane(t) {
  const p = await openSwitchPage(browser);
  t.after(async () => {
    const { errors } = p;
    await p.page.close();
    assert.deepEqual(errors, []);
  });
  return p;
}

/** Page script: the shown pane's transcript, the part of it the dock leaves shown, and where the row `key` (when
 *  mounted) stands in it (`offset`, below the thread's top padding). */
function placeProbe(key) {
  const view = document.querySelector(
    '.persistent-pane-surface:not([data-retained]):not([data-preparing]) .transcript'
  );
  const thread = view.querySelector('.thread');
  const pad = Number.parseFloat(getComputedStyle(thread).paddingTop) || 0;
  const box = view.getBoundingClientRect();
  const inset = Number.parseFloat(view.style.getPropertyValue('--transcript-dock-inset')) || 0;
  const dock = view.closest('.conversation').querySelector('.composer-region').getBoundingClientRect();
  const row = key ? view.querySelector(`.transcript-virtual-row[data-timeline-key="${key}"]`) : null;
  const rect = row?.getBoundingClientRect();
  return {
    top: view.scrollTop,
    client: view.clientHeight,
    inset,
    // The dock's top edge is where the shown part of the viewport ends.
    shown: Math.round(dock.top - box.top),
    row: rect ? { size: rect.height, offset: rect.top - box.top - pad } : null,
  };
}

test('a record opened in old history is centered in the part of the view the composer dock leaves shown', async (t) => {
  const p = await quietPane(t);
  await p.act(() => {
    window.rig.core.seed('A', 30, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.openAt('A', 'A-u12'));
  const at = await p.run(placeProbe, 'A:A-u12');
  t.diagnostic(`centered: ${JSON.stringify(at)}`);
  assert.ok(at.inset > 0, 'the dock covers the bottom of the viewport');
  assert.equal(at.client - at.inset, at.shown, 'the inset is what the dock covers');
  assert.ok(at.row, 'the record is on screen');
  assert.ok(
    Math.abs(at.row.offset - (at.shown - at.row.size) / 2) <= 1,
    `its row is mid-way down the shown part (${at.row.offset} for ${(at.shown - at.row.size) / 2})`
  );
});

test('Space and Shift+Space on the focused transcript never page past what the dock covers', async (t) => {
  const p = await quietPane(t);
  await p.act(() => {
    window.rig.core.seed('A', 30, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.wheel('pane-1', -1500));
  const moves = [];
  for (const shift of [false, true]) {
    const before = await p.run(placeProbe, '');
    await p.run(() =>
      document.querySelector('.persistent-pane-surface:not([data-retained]) .transcript').focus({ preventScroll: true })
    );
    if (shift) await p.page.keyboard.down('Shift');
    await p.page.keyboard.press('Space');
    if (shift) await p.page.keyboard.up('Shift');
    await p.act(() => {});
    const after = await p.run(placeProbe, '');
    const focused = await p.run(() => document.activeElement?.tagName.toLowerCase() ?? null);
    moves.push({ shift, moved: after.top - before.top, shown: before.shown, focused });
  }
  t.diagnostic(`space: ${JSON.stringify(moves)}`);
  for (const { shift, moved, shown } of moves) {
    assert.ok(
      Math.abs(moved) <= shown,
      `${shift ? 'Shift+Space' : 'Space'} moved ${moved}px past the ${shown}px shown`
    );
  }
});
