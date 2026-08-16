export const WIDTH_TRACE_INSTALL_SCRIPT = `(() => {
  const w = window;
  const transcript = [...document.querySelectorAll('.transcript')]
    .find((node) => node.getBoundingClientRect().height > 0
      && node.querySelectorAll('.transcript-virtual-row').length > 3);
  if (!transcript) return { error: 'no transcript' };
  const sessionKey = transcript.getAttribute('data-session-key') || '';
  if (!w.__widthTraceInstalled) {
    w.__widthTraceInstalled = true;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        const trace = w.__widthTrace;
        if (trace && this.classList && this.classList.contains('transcript')) {
          trace.writes.push({
            t: Math.round(performance.now()),
            from: Math.round(descriptor.get.call(this)),
            to: Math.round(Number(value) || 0),
            bottom: Math.round(this.scrollHeight - this.clientHeight),
            width: Math.round(this.clientWidth),
            stack: String(new Error().stack || '').split('\\n').slice(2, 5)
              .map((line) => line.trim().replace(/^at\\s+/, '')).join(' <- '),
          });
        }
        descriptor.set.call(this, value);
      },
    });
  }
  w.__widthTrace = { writes: [], samples: [], raf: 0 };
  const sample = () => {
    const node = [...document.querySelectorAll('.transcript')]
      .find((candidate) => candidate.getAttribute('data-session-key') === sessionKey);
    if (node) {
      const box = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll('.transcript-virtual-row')]
        .map((row) => ({ row, rect: row.getBoundingClientRect() }))
        .filter((entry) => entry.rect.bottom > box.top + 1)
        .sort((a, b) => a.rect.top - b.rect.top);
      const top = rows[0];
      const tail = rows[rows.length - 1];
      const frame = node.querySelector(
        '.transcript-virtual-row-content[data-tag="AssistantPart"],'
          + '.transcript-virtual-row-content[data-tag="UserMessage"]',
      );
      const frameBox = frame?.getBoundingClientRect();
      const frameStyle = frame ? getComputedStyle(frame) : null;
      const paddingLeft = Number.parseFloat(frameStyle?.paddingLeft || '0') || 0;
      const paddingRight = Number.parseFloat(frameStyle?.paddingRight || '0') || 0;
      const pane = node.closest('.workspace');
      const composer = pane?.querySelector('.composer-region');
      const header = pane?.querySelector('.session-header-content');
      const composerBox = composer?.getBoundingClientRect();
      const headerBox = header?.getBoundingClientRect();
      w.__widthTrace.samples.push({
        t: Math.round(performance.now()),
        width: Math.round(box.width),
        paneWidth: Math.round(pane?.getBoundingClientRect().width || box.width),
        scrollTop: Math.round(node.scrollTop),
        bottom: Math.round(node.scrollHeight - node.clientHeight),
        distance: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
        following: node.getAttribute('data-following'),
        index: top ? Number(top.row.getAttribute('data-index')) : null,
        offset: top ? Math.round(top.rect.top - box.top) : null,
        tailIndex: tail ? Number(tail.row.getAttribute('data-index')) : null,
        tailOffset: tail ? Math.round(tail.rect.bottom - box.bottom) : null,
        frameWidth: frameBox ? Math.round(frameBox.width) : null,
        framePadding: Math.round((paddingLeft + paddingRight) * 10) / 10,
        textWidth: frameBox
          ? Math.round((frameBox.width - paddingLeft - paddingRight) * 10) / 10
          : null,
        composerWidth: composerBox ? Math.round(composerBox.width) : null,
        headerWidth: headerBox ? Math.round(headerBox.width) : null,
        space: Math.round(
          node.querySelector('.transcript-virtual-space')?.getBoundingClientRect().height || 0,
        ),
      });
    }
    w.__widthTrace.raf = requestAnimationFrame(sample);
  };
  w.__widthTrace.raf = requestAnimationFrame(sample);
  return {
    rows: transcript.querySelectorAll('.transcript-virtual-row').length,
    scrollHeight: transcript.scrollHeight,
    clientHeight: transcript.clientHeight,
  };
})()`;

export const WIDTH_TRACE_COLLECT_SCRIPT = `(() => {
  const w = window;
  cancelAnimationFrame(w.__widthTrace.raf);
  const trace = w.__widthTrace;
  const byIndex = new Map();
  const byTailIndex = new Map();
  const byPaneWidth = new Map();
  for (const sample of trace.samples) {
    if (sample.index !== null && sample.offset !== null) {
      const bucket = byIndex.get(sample.index) || [];
      bucket.push(sample.offset);
      byIndex.set(sample.index, bucket);
    }
    if (sample.tailIndex !== null && sample.tailOffset !== null) {
      const bucket = byTailIndex.get(sample.tailIndex) || [];
      bucket.push(sample.tailOffset);
      byTailIndex.set(sample.tailIndex, bucket);
    }
    if (sample.paneWidth !== null) {
      const bucket = byPaneWidth.get(sample.paneWidth) || [];
      bucket.push(sample);
      byPaneWidth.set(sample.paneWidth, bucket);
    }
  }
  let worstDrift = 0;
  for (const offsets of byIndex.values()) {
    worstDrift = Math.max(worstDrift, Math.max(...offsets) - Math.min(...offsets));
  }
  let worstTailDrift = 0;
  for (const offsets of byTailIndex.values()) {
    worstTailDrift = Math.max(worstTailDrift, Math.max(...offsets) - Math.min(...offsets));
  }
  let sameWidthFrameRange = 0;
  let sameWidthPaddingRange = 0;
  const widthProfile = [];
  for (const [paneWidth, samples] of [...byPaneWidth.entries()].sort((a, b) => a[0] - b[0])) {
    const values = (key) => samples.map((sample) => sample[key]).filter(Number.isFinite);
    const frames = values('frameWidth');
    const paddings = values('framePadding');
    const texts = values('textWidth');
    if (frames.length) {
      sameWidthFrameRange = Math.max(
        sameWidthFrameRange,
        Math.max(...frames) - Math.min(...frames),
      );
    }
    if (paddings.length) {
      sameWidthPaddingRange = Math.max(
        sameWidthPaddingRange,
        Math.max(...paddings) - Math.min(...paddings),
      );
    }
    widthProfile.push({
      paneWidth,
      frameWidth: frames.length ? frames[frames.length - 1] : null,
      framePadding: paddings.length ? paddings[paddings.length - 1] : null,
      textWidth: texts.length ? texts[texts.length - 1] : null,
    });
  }
  let maxFrameWidthRegression = 0;
  let maxTextWidthRegression = 0;
  for (let index = 1; index < widthProfile.length; index += 1) {
    const previous = widthProfile[index - 1];
    const current = widthProfile[index];
    if (previous.frameWidth !== null && current.frameWidth !== null) {
      maxFrameWidthRegression = Math.max(
        maxFrameWidthRegression,
        previous.frameWidth - current.frameWidth,
      );
    }
    if (previous.textWidth !== null && current.textWidth !== null) {
      maxTextWidthRegression = Math.max(
        maxTextWidthRegression,
        previous.textWidth - current.textWidth,
      );
    }
  }
  const tops = trace.samples.map((sample) => sample.scrollTop);
  let reversals = 0;
  for (let index = 2; index < tops.length; index += 1) {
    const previousDelta = tops[index - 1] - tops[index - 2];
    const currentDelta = tops[index] - tops[index - 1];
    if (Math.abs(previousDelta) > 8
      && Math.abs(currentDelta) > 8
      && Math.sign(previousDelta) !== Math.sign(currentDelta)) {
      reversals += 1;
    }
  }
  const jumps = trace.writes
    .map((write) => ({
      ...write,
      delta: write.to - write.from,
      offBottom: write.to - write.bottom,
    }))
    .filter((write) => Math.abs(write.delta) > 8);
  let maxFrameAnchorJump = 0;
  let maxFrameTailJump = 0;
  let maxFrameScrollJump = 0;
  for (let index = 1; index < trace.samples.length; index += 1) {
    const previous = trace.samples[index - 1];
    const current = trace.samples[index];
    maxFrameScrollJump = Math.max(
      maxFrameScrollJump,
      Math.abs(current.scrollTop - previous.scrollTop),
    );
    if (current.index === null || previous.index === null) continue;
    if (current.index === previous.index) {
      maxFrameAnchorJump = Math.max(
        maxFrameAnchorJump,
        Math.abs(current.offset - previous.offset),
      );
    }
    if (current.tailIndex === previous.tailIndex
      && current.tailOffset !== null
      && previous.tailOffset !== null) {
      maxFrameTailJump = Math.max(
        maxFrameTailJump,
        Math.abs(current.tailOffset - previous.tailOffset),
      );
    }
  }
  return {
    frames: trace.samples.length,
    writes: trace.writes.length,
    worstAnchorDrift: worstDrift,
    worstTailDrift,
    maxFrameAnchorJump,
    maxFrameTailJump,
    maxFrameScrollJump,
    maxBottomDistance: trace.samples.length
      ? Math.max(...trace.samples.map((sample) => Math.abs(sample.distance)))
      : 0,
    maxNarrowBottomDistance: trace.samples.length
      ? Math.max(0, ...trace.samples
          .filter((sample) => sample.paneWidth <= 520)
          .map((sample) => Math.abs(sample.distance)))
      : 0,
    sameWidthFrameRange,
    sameWidthPaddingRange,
    maxFrameWidthRegression,
    maxTextWidthRegression,
    widthProfile: widthProfile.filter((sample, index) =>
      index === 0
        || index === widthProfile.length - 1
        || sample.framePadding !== widthProfile[index - 1].framePadding
        || sample.frameWidth !== widthProfile[index - 1].frameWidth),
    scrollReversals: reversals,
    scrollRange: tops.length ? Math.max(...tops) - Math.min(...tops) : 0,
    biggestWrites: jumps
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, 8),
    writeStacks: [...new Set(trace.writes.map((write) => write.stack))].slice(0, 8),
  };
})()`;
