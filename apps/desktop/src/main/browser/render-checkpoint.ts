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
