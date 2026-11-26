// A frame holds the reply's article and markdown node ids, its top-level block ids (all, and those in view), its height, whether it
// settled, and `runs` of [offset, length, opacity] over its non-whitespace characters in document order.

/** Page script: `window.__streamFrames` gains one sample per animation frame. */
export const STREAM_FRAME_PROBE = `
  (() => {
    const ids = new WeakMap();
    let nextId = 1;
    const idOf = (node) => {
      if (!node) return 0;
      let id = ids.get(node);
      if (!id) { id = nextId++; ids.set(node, id); }
      return id;
    };
    const frames = [];
    window.__streamFrames = frames;
    const opacityOf = (element, stop, cache) => {
      let value = 1;
      for (let node = element; node && node !== stop.parentElement; node = node.parentElement) {
        let own = cache.get(node);
        if (own === undefined) { own = Number(getComputedStyle(node).opacity); cache.set(node, own); }
        value *= own;
      }
      return value;
    };
    // The frame's time is the one its animations are sampled at.
    const sample = (frameTime) => {
      const article = document.querySelector('article.message.assistant');
      const markdown = article?.querySelector('.markdown');
      const viewport = document.querySelector('.transcript');
      const frame = { t: frameTime, scrollTop: viewport ? viewport.scrollTop : 0 };
      if (article && markdown && viewport) {
        const view = viewport.getBoundingClientRect();
        const blocks = [...markdown.children];
        frame.articleId = idOf(article);
        frame.markdownId = idOf(markdown);
        frame.settled = article.classList.contains('settled');
        frame.height = article.getBoundingClientRect().height;
        frame.blockIds = blocks.map(idOf);
        frame.viewBlockIds = blocks.filter((block) => {
          const rect = block.getBoundingClientRect();
          return rect.bottom > view.top && rect.top < view.bottom;
        }).map(idOf);
        const cache = new Map();
        const walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT);
        const runs = [];
        let offset = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const painted = (node.nodeValue ?? '').replace(/\\s+/g, '').length;
          if (!painted || node.parentElement?.closest('[hidden]')) continue;
          const opacity = Math.round(opacityOf(node.parentElement, markdown, cache) * 1000) / 1000;
          const last = runs[runs.length - 1];
          if (last && last[2] === opacity && last[0] + last[1] === offset) last[1] += painted;
          else runs.push([offset, painted, opacity]);
          offset += painted;
        }
        frame.runs = runs;
        frame.painted = offset;
      }
      frames.push(frame);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })();
`;

/**
 * What changes on screen between consecutive frames from `from` to `to`
 * beyond the reveal itself, as messages (empty: none): the reply's article,
 * its markdown root or a top-level block in view replaced; a painted
 * character below full ink (streamed text shows without a fade); the reply's
 * height changing in a frame that painted no new character.
 */
export function completionFlashes(frames, { from, to }) {
  const found = [];
  let previous = null;
  for (const frame of frames) {
    if (frame.runs === undefined) continue;
    if (frame.t < from) {
      previous = frame;
      continue;
    }
    if (frame.t > to) break;
    if (previous) {
      const at = Math.round(frame.t);
      if (frame.articleId !== previous.articleId) found.push(`${at}: the reply's article was replaced`);
      if (frame.markdownId !== previous.markdownId) found.push(`${at}: the reply's markdown root was replaced`);
      const gone = previous.viewBlockIds.filter((id) => !frame.blockIds.includes(id));
      if (gone.length) found.push(`${at}: ${gone.length} top-level block(s) in view replaced`);
      if (Math.abs(frame.height - previous.height) > 0.5 && frame.painted === previous.painted) {
        found.push(`${at}: height ${previous.height} -> ${frame.height} with no new character`);
      }
      const faint = frame.runs.filter((run) => run[2] < 1).reduce((sum, run) => sum + run[1], 0);
      if (faint) found.push(`${at}: ${faint} painted character(s) below full ink`);
    }
    previous = frame;
  }
  return found;
}

/** The painted characters each frame from `from` on added, with their times. */
export function revealSteps(frames, from) {
  const steps = [];
  let painted = null;
  for (const frame of frames) {
    if (frame.painted === undefined) continue;
    if (frame.t >= from && painted !== null && frame.painted !== painted) {
      steps.push({ t: frame.t, chars: frame.painted - painted });
    }
    painted = frame.painted;
  }
  return steps;
}
