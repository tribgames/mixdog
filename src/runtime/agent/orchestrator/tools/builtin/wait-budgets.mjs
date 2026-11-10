// The one place the shell hold and the task wait budgets are set. Every
// schema, clamp, description and result text reads them from here.
//
// Shell hold: how long a foreground command may hold the tool call before it
// moves to the background (it keeps running; completion is delivered
// automatically). New user input ends the hold early. `wait_ms` picks a
// different hold for one call, clamped to MIN..MAX.
export const SHELL_HOLD_DEFAULT_MS = 60_000;
export const SHELL_HOLD_MIN_MS = 1_000;
export const SHELL_HOLD_MAX_MS = 600_000;

// `task wait` ceiling. The wait returns the moment the task settles or new
// user input arrives, so the ceiling only bounds a still-running task. The
// floor stops a caller from turning wait into a busy poll. An agent's default
// stays under the 5 m prompt-cache TTL with room for the turn's own generation
// time, so a wait that runs to the ceiling wakes to a warm cache.
export const TASK_WAIT_DEFAULT_MS = 300_000;
export const AGENT_TASK_WAIT_DEFAULT_MS = 240_000;
export const TASK_WAIT_MIN_MS = 10_000;
export const TASK_WAIT_MAX_MS = 3_600_000;

/** Whole seconds for descriptions and result text. */
export const budgetSeconds = (ms) => Math.round(ms / 1000);
