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

function opacities(runs) {
  const out = [];
  for (const [offset, length, opacity] of runs ?? [])
    for (let index = 0; index < length; index += 1) out[offset + index] = opacity;
  return out;
}

/**
 * What changes on screen between consecutive frames from `from` to `to`
 * beyond the reveal itself, as messages (empty: none): the reply's article,
 * its markdown root or a top-level block in view replaced; a painted
 * character's opacity dropping, or rising faster than a fade of `fadeMs`
 * allows (a fade sped up, or text popping in); the reply's height changing in
 * a frame that painted no new character.
 */
export function completionFlashes(frames, { from, to, fadeMs }) {
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
      const was = opacities(previous.runs);
      const now = opacities(frame.runs);
      const limit = ((frame.t - previous.t) / fadeMs) * 1.25 + 0.02;
      let drops = 0;
      let jumps = 0;
      for (let index = 0; index < Math.min(was.length, now.length); index += 1) {
        if (now[index] < was[index] - 0.02) drops += 1;
        else if (now[index] - was[index] > limit) jumps += 1;
      }
      if (drops) found.push(`${at}: ${drops} painted character(s) lost opacity`);
      if (jumps) found.push(`${at}: ${jumps} character(s) gained opacity faster than a ${fadeMs} ms fade`);
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
