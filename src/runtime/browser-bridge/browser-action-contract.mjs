/** Browser Use action names shared by the runtime schema and Electron host.
 * The integration harness proves that every entry completes through the live
 * loopback bridge; this module only owns the stable public names and groups. */
export const BROWSER_ACTIONS = Object.freeze([
  'navigate', 'snapshot', 'locate', 'evaluate', 'emulate', 'cookies', 'storage',
  'performance', 'click', 'fill', 'type', 'select', 'check', 'hover', 'drag',
  'upload', 'handle_dialog', 'press', 'scroll', 'back', 'forward', 'sequence',
  'read', 'extract', 'wait', 'status', 'console', 'network', 'intercept',
  'init_script', 'list_tabs', 'close_tab', 'downloads', 'open',
]);

export const BROWSER_OBSERVATION_ACTIONS = Object.freeze([
  'snapshot', 'read', 'extract', 'locate', 'status', 'console', 'network',
  'list_tabs', 'downloads', 'wait',
]);

export const BROWSER_POSTCONDITION_ACTIONS = Object.freeze([
  'navigate', 'evaluate', 'emulate', 'click', 'fill', 'type', 'select',
  'check', 'hover', 'drag', 'upload', 'handle_dialog', 'press', 'scroll',
  'back', 'forward', 'sequence',
]);

export const BROWSER_SEQUENCE_STEP_ACTIONS = Object.freeze([
  'click', 'fill', 'type', 'select', 'check', 'hover', 'press', 'scroll', 'wait',
]);
