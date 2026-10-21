/** Visible documents yield through painting. Hidden documents may never
 * receive animation frames: yield a task and flush layout instead, leaving
 * actionability and explicit asynchronous dependencies to their owners. */
export const browserRenderCheckpoint = (background = false) => `(() => new Promise((resolve) => {
  if (${background} || document.hidden) {
    setTimeout(() => {
      document.documentElement?.getBoundingClientRect();
      resolve();
    }, 0);
    return;
  }
  let frame;
  const finish = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    resolve();
  };
  const timer = setTimeout(finish, 100);
  frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
}))()`;

const MARKS = '(globalThis.__mixdogRenderCheckpoints ||= {})';

/** One frame's part of checkpoint `id`, read synchronously so nothing is left
 * awaiting in a page that can never run timers. A frame (or isolated world)
 * that has no marker yet was never checkpointed: schedule it now and report it
 * pending. A marker that fired is consumed and reports done. The callback only
 * completes a marker that still exists, so a checkpoint that already ended
 * cannot be recreated by a late timer. */
export const browserRenderCheckpointPoll = (id: number, background = false) => `(() => {
  const marks = ${MARKS};
  if (${id} in marks) {
    if (marks[${id}] !== true) return false;
    delete marks[${id}];
    return true;
  }
  marks[${id}] = false;
  (${browserRenderCheckpoint(background)}).then(() => { if (${id} in marks) marks[${id}] = true; });
  return false;
})()`;

/** Drops the marker of an ended checkpoint, so none outlives it. */
export const browserRenderCheckpointEnd = (id: number) => `(() => {
  delete ${MARKS}[${id}];
  return true;
})()`;
