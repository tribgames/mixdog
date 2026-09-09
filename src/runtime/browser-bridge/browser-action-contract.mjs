/** Browser Use action names shared by the runtime schema and Electron host.
 * The integration harness proves that every entry completes through the live
 * loopback bridge; this module only owns the stable public names and groups. */
export const BROWSER_ACTIONS = Object.freeze([
  'navigate', 'snapshot', 'locate', 'evaluate', 'emulate', 'cookies', 'storage',
  'performance', 'click', 'fill', 'type', 'select', 'hover', 'drag',
  'upload', 'handle_dialog', 'press', 'scroll', 'back', 'sequence',
  'read', 'extract', 'wait', 'status', 'console', 'network', 'intercept',
  'init_script', 'list_tabs', 'close_tab', 'downloads', 'open', 'hide',
]);

/** Developer controls: environment shaping and page state that everyday page
 *  work never touches. They ride the deferred `browser_devtools` tool so the
 *  schema every turn carries stays the one that clicks, fills, reads, and
 *  navigates; the host serves both tools through one bridge. */
export const BROWSER_DEVTOOLS_ACTIONS = Object.freeze([
  'emulate', 'cookies', 'storage', 'intercept', 'init_script', 'performance',
]);

/** Everyday page work: the default `browser` tool's actions. */
export const BROWSER_PAGE_ACTIONS = Object.freeze(
  BROWSER_ACTIONS.filter((action) => !BROWSER_DEVTOOLS_ACTIONS.includes(action)),
);

export const BROWSER_TOOL_NAME = 'browser';
export const BROWSER_DEVTOOLS_TOOL_NAME = 'browser_devtools';
/** Both tools drive the same bridge, pages, and sign-in. */
export const BROWSER_TOOL_NAMES = Object.freeze([BROWSER_TOOL_NAME, BROWSER_DEVTOOLS_TOOL_NAME]);

export function browserToolForAction(action) {
  return BROWSER_DEVTOOLS_ACTIONS.includes(action) ? BROWSER_DEVTOOLS_TOOL_NAME : BROWSER_TOOL_NAME;
}

export const BROWSER_OBSERVATION_ACTIONS = Object.freeze([
  'snapshot', 'read', 'extract', 'locate', 'status', 'console', 'network',
  'list_tabs', 'downloads', 'wait',
]);

export const BROWSER_POSTCONDITION_ACTIONS = Object.freeze([
  'navigate', 'evaluate', 'emulate', 'click', 'fill', 'type', 'select',
  'hover', 'drag', 'upload', 'handle_dialog', 'press', 'scroll',
  'back', 'sequence',
]);

/** A checkbox is set by `fill` with `checked` (one control or a `fields`
 *  item), so no separate check gesture exists here or at the top level. */
export const BROWSER_SEQUENCE_STEP_ACTIONS = Object.freeze([
  'click', 'fill', 'type', 'select', 'hover', 'press', 'scroll', 'wait',
]);
