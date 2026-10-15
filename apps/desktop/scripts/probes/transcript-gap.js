// Transcript tail gap over the bottom chrome (diagnosis tooling).
//
//   node scripts/dom-eval.mjs --port=9342 scripts/probes/transcript-gap.js
//
// Drives each scenario itself in the visible conversation pane and samples
// every PAINTED frame (read in the task right after the frame) for a bounded
// window: the gap between the last transcript row and the top of the topmost
// visible bottom chrome (island, quota card, /btw card, queue tray, context
// bar, composer), the scroller's scrollTop/scrollHeight/clientHeight and the
// dock height. Chrome is driven with stand-in nodes carrying the real class
// names (so the real CSS and the real end pin react), the textarea through
// its native input path, the session switch and the reading release through
// real clicks/wheel events. Every stand-in and the typed draft are restored.
//
// The gap is measured to the dock's top (the transcript/dock boundary);
// chromeGap is the same to the topmost visible chrome member. Island
// scenarios sample ISLAND_FRAMES, which spans the collapse grace and the
// slot's height easing; `frames` lists gap/clientHeight/scrollTop per frame.
// `resized` holds the same reads taken inside every resize delivery (after
// the timeline's observer and its end pin) — what each frame paints. A
// post-paint sample can occasionally read the NEXT frame's animation tick
// before its pin has run; that state is never painted.
//
// Optional, from an earlier eval: window.__transcriptGapScenarios = ['island', ...]
// and window.__transcriptGapSessions = [overflowingLeadRow, otherLeadRow].
(async () => {
  const FRAMES = 36;
  // Grace (500ms) plus the 200ms easing, with room to rest.
  const ISLAND_FRAMES = { ms: 1100 };
  const all = [
    'session',
    'island',
    'island-flicker',
    'island-tall',
    'quota',
    'btw',
    'queue',
    'textarea',
    'resize',
    'reading',
  ];
  const scenarios = window.__transcriptGapScenarios ?? all;
  const [sessionA, sessionB] = window.__transcriptGapSessions ?? [0, 1];
  const round = (value) => (value == null ? null : Math.round(value * 10) / 10);
  const afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      })
    );
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pane = () => {
    const panes = [...document.querySelectorAll('.conversation')].filter(
      (element) => element.getClientRects().length && element.querySelector('.transcript')
    );
    return panes.find((element) => element.contains(document.activeElement)) ?? panes[0];
  };
  // Layout top (offset chain up to the pane), so a chrome member's own pop or
  // rise animation (a transform) never reads as transcript movement.
  const layoutTop = (element, conversation) => {
    let top = 0;
    for (let node = element; node && node !== conversation; node = node.offsetParent) top += node.offsetTop;
    return conversation.getBoundingClientRect().top + top;
  };
  const visibleTop = (element, conversation) => {
    if (!element?.offsetHeight || getComputedStyle(element).visibility === 'hidden') return null;
    return layoutTop(element, conversation);
  };
  const sample = () => {
    const conversation = pane();
    const viewport = conversation?.querySelector('.transcript');
    const dock = conversation?.querySelector('.composer-region');
    if (!viewport || !dock) return { missing: true };
    const rows = [...viewport.querySelectorAll('.transcript-virtual-row')];
    const last = rows.reduce(
      (best, row) => (!best || Number(row.dataset.index) > Number(best.dataset.index) ? row : best),
      null
    );
    const chrome = [
      dock.querySelector('.composer-island'),
      ...dock.querySelectorAll(':scope > .composer-quota-card, :scope > .composer-context-bar, :scope > .btw-card'),
      dock.querySelector(':scope > .composer-queue-tray'),
      dock.querySelector('form.composer'),
    ]
      .map((element) => visibleTop(element, conversation))
      .filter((top) => top != null);
    const chromeTop = Math.min(...chrome);
    const lastBottom = last?.getBoundingClientRect().bottom ?? null;
    const dockBox = dock.getBoundingClientRect();
    const slot = dock.querySelector('.composer-island-slot');
    return {
      key: viewport.dataset.sessionKey?.slice(-6),
      following: viewport.dataset.following === 'true',
      revealed: viewport.style.visibility !== 'hidden',
      gap: lastBottom == null ? null : round(dockBox.top - lastBottom),
      chromeGap: lastBottom == null ? null : round(chromeTop - lastBottom),
      atEnd: round(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
      st: round(viewport.scrollTop),
      sh: viewport.scrollHeight,
      ch: viewport.clientHeight,
      dockH: round(dockBox.height),
      slotH: slot ? round(slot.getBoundingClientRect().height) : null,
      presence: slot?.getAttribute('data-presence') ?? null,
      motion: slot?.hasAttribute('data-motion') ?? null,
    };
  };
  /** Samples painted frames after `action` (run in its own task): `frames`
   *  frames, or for a `{ ms }` window every frame painted within it. */
  const record = async (action, frames = FRAMES, extra) => {
    await afterPaint();
    const before = { ...sample(), ...(extra?.() ?? {}) };
    // In-frame reads: every resize delivery (after the timeline's own
    // observer and its pin), i.e. what that frame paints.
    const resized = [];
    const watcher = new ResizeObserver(() => resized.push(sample()));
    watcher.observe(viewport());
    watcher.observe(dock());
    await afterPaint();
    resized.length = 0;
    const start = performance.now();
    await action?.();
    const samples = [];
    const more = () => (typeof frames === 'number' ? samples.length < frames : performance.now() - start < frames.ms);
    while (more()) {
      await afterPaint();
      samples.push({ ...sample(), ...(extra?.() ?? {}), t: Math.round(performance.now() - start) });
    }
    watcher.disconnect();
    const summary = summarize(before, samples);
    const inFrame = resized.filter((entry) => entry.following && entry.gap != null);
    summary.resized = {
      count: resized.length,
      gap: inFrame.length ? [Math.min(...inFrame.map((e) => e.gap)), Math.max(...inFrame.map((e) => e.gap))] : null,
      notAtEnd: inFrame.filter((entry) => entry.atEnd >= 1).length,
    };
    return summary;
  };
  const summarize = (before, samples) => {
    // Every painted frame while following, including any that lag the end.
    const tail = samples.filter((entry) => entry.revealed && entry.gap != null && entry.following);
    const gaps = tail.map((entry) => entry.gap);
    const settled = samples.at(-1);
    return {
      before: pick(before),
      settled: pick(settled),
      gap: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), distinct: [...new Set(gaps)] } : null,
      // Painted tail frames whose gap differs from the settled gap: a visible jump.
      offFrames: tail.filter((entry) => Math.abs(entry.gap - settled.gap) > 1).length,
      notAtEnd: samples.filter((entry) => entry.following && entry.revealed && entry.atEnd >= 1).length,
      anchor:
        samples[0]?.anchorDelta === undefined ? undefined : [...new Set(samples.map((entry) => entry.anchorDelta))],
      // Frames whose dock height lies strictly between its two resting values.
      easedFrames: samples.filter(
        (entry) => Math.abs(entry.dockH - before.dockH) >= 1 && Math.abs(entry.dockH - settled.dockH) >= 1
      ).length,
      // When the dock first moved, ms after the action (the grace hold, for a collapse).
      firstMoveMs: samples.find((entry) => Math.abs(entry.dockH - before.dockH) >= 1)?.t ?? null,
      sampled: samples.length,
      dockHeights: [...new Set(samples.map((entry) => entry.dockH))],
      scrollTops: [...new Set(samples.map((entry) => entry.st))],
      frames: samples.map((entry) => `${entry.gap ?? '-'}/${entry.ch}/${entry.st}`).join(' '),
    };
  };
  const pick = (entry) =>
    entry && {
      key: entry.key,
      following: entry.following,
      gap: entry.gap,
      chromeGap: entry.chromeGap,
      atEnd: entry.atEnd,
      st: entry.st,
      sh: entry.sh,
      ch: entry.ch,
      dockH: entry.dockH,
      slotH: entry.slotH,
      presence: entry.presence,
    };
  const viewport = () => pane().querySelector('.transcript');
  const dock = () => pane().querySelector('.composer-region');
  const toTail = async () => {
    const element = viewport();
    // Arrive inside the return band first: landing exactly on an end offset
    // the timeline itself wrote moments ago reads as its own write, not the
    // reader coming back.
    element.scrollTop = element.scrollHeight - element.clientHeight - 3;
    await afterPaint();
    element.scrollTop = element.scrollHeight;
    for (let frame = 0; frame < 6; frame++) await afterPaint();
  };
  const leadRows = () =>
    [...document.querySelectorAll('.agent-pool-row')].filter((row) => row.getBoundingClientRect().left < 300);
  const stand = (className, html, style = '') => {
    const element = document.createElement('div');
    element.className = className;
    element.dataset.transcriptGapProbe = 'true';
    element.setAttribute('style', style);
    element.innerHTML = html;
    return element;
  };
  const setDraft = (value) => {
    const area = dock().querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pair = async (show, hide, frames = FRAMES) => ({
    show: await record(show, frames),
    hide: await record(hide, frames),
  });
  const pillSegment = () => {
    const segment = document.createElement('span');
    segment.className = 'composer-island-seg';
    segment.dataset.transcriptGapProbe = 'true';
    segment.textContent = 'probe';
    return segment;
  };

  const results = {};
  const run = {
    async session() {
      leadRows()[sessionA]?.click();
      await wait(1200);
      await toTail();
      return {
        away: await record(() => leadRows()[sessionB]?.click(), 60),
        back: await record(() => leadRows()[sessionA]?.click(), 60),
      };
    },
    async island() {
      const segment = pillSegment();
      return pair(
        () => dock().querySelector('.composer-island-pill')?.append(segment),
        () => segment.remove(),
        ISLAND_FRAMES
      );
    },
    // Content off, then back on 250ms later (inside the grace): nothing moves.
    async 'island-flicker'() {
      const segment = pillSegment();
      const open = await record(() => dock().querySelector('.composer-island-pill')?.append(segment), ISLAND_FRAMES);
      // Not awaited: the frames are sampled across the off/on window.
      const flicker = await record(() => {
        segment.remove();
        setTimeout(() => dock().querySelector('.composer-island-pill')?.append(segment), 250);
      }, ISLAND_FRAMES);
      const close = await record(() => segment.remove(), ISLAND_FRAMES);
      return { open, flicker, close };
    },
    async 'island-tall'() {
      let card;
      return pair(
        () => {
          card = stand('composer-island-approval', '<div style="height:220px">probe approval</div>');
          dock().querySelector('.composer-island')?.prepend(card);
        },
        () => card.remove(),
        ISLAND_FRAMES
      );
    },
    async quota() {
      let card;
      return pair(
        () => {
          card = stand('composer-quota-card', '<span>probe quota</span>');
          dock().insertBefore(card, dock().querySelector(':scope > .composer-queue-tray'));
        },
        () => card.remove()
      );
    },
    async btw() {
      let card;
      return pair(
        () => {
          card = stand('btw-card', '<div class="btw-head">probe</div><div class="btw-body"><p>one</p><p>two</p></div>');
          dock().insertBefore(card, dock().querySelector(':scope > form.composer'));
        },
        () => card.remove()
      );
    },
    async queue() {
      let list;
      return pair(
        () => {
          list = stand(
            'queue-list',
            '<div class="queue-items"><div class="queue-item">probe one</div><div class="queue-item">probe two</div></div>'
          );
          dock().querySelector(':scope > .composer-queue-tray')?.append(list);
        },
        () => list.remove()
      );
    },
    async textarea() {
      const original = dock().querySelector('textarea').value;
      const grow = await record(() => setDraft('line 1\nline 2\nline 3\nline 4\nline 5\nline 6'));
      const clear = await record(() => setDraft(''));
      setDraft(original);
      await afterPaint();
      return { grow, clear };
    },
    async resize() {
      const conversation = pane();
      const { width, height } = conversation.getBoundingClientRect();
      const out = {};
      out.shorter = await record(() => conversation.style.setProperty('max-height', `${Math.round(height - 160)}px`));
      out.taller = await record(() => conversation.style.removeProperty('max-height'));
      out.narrower = await record(() => conversation.style.setProperty('max-width', `${Math.round(width - 260)}px`));
      out.wider = await record(() => conversation.style.removeProperty('max-width'));
      return out;
    },
    async reading() {
      const element = viewport();
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 400);
      await wait(400);
      const view = element.getBoundingClientRect();
      // The row under the viewport's top edge (rows can be taller than it).
      const anchor = [...element.querySelectorAll('.transcript-virtual-row')].find((row) => {
        const box = row.getBoundingClientRect();
        return box.bottom > view.top + 40;
      });
      const anchorTop = anchor?.getBoundingClientRect().top;
      const extra = () => ({ anchorDelta: anchor ? round(anchor.getBoundingClientRect().top - anchorTop) : null });
      let list;
      let card;
      const segment = pillSegment();
      const out = {
        show: await record(
          () => {
            list = stand('queue-list', '<div class="queue-items"><div class="queue-item">probe</div></div>');
            dock().querySelector(':scope > .composer-queue-tray')?.append(list);
            card = stand('composer-quota-card', '<span>probe quota</span>');
            dock().insertBefore(card, dock().querySelector(':scope > .composer-queue-tray'));
          },
          FRAMES,
          extra
        ),
        hide: await record(
          () => {
            list.remove();
            card.remove();
          },
          FRAMES,
          extra
        ),
        islandShow: await record(
          () => dock().querySelector('.composer-island-pill')?.append(segment),
          ISLAND_FRAMES,
          extra
        ),
        islandHide: await record(() => segment.remove(), ISLAND_FRAMES, extra),
      };
      await toTail();
      return out;
    },
  };
  try {
    for (const name of scenarios) {
      if (name !== 'session') await toTail();
      results[name] = await run[name]();
    }
  } finally {
    for (const node of document.querySelectorAll('[data-transcript-gap-probe]')) node.remove();
    pane()?.style.removeProperty('max-height');
    pane()?.style.removeProperty('max-width');
  }
  return results;
})();
