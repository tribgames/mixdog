import assert from "node:assert/strict";
import test from "node:test";

import { SHELL_RELOAD_IDLE_MS, shellReloadDelay } from "./use-shell-update-reload";

const idle = {
  pending: true,
  busy: false,
  hidden: false,
  editing: false,
  idleFor: SHELL_RELOAD_IDLE_MS,
};

test("no pending deploy schedules nothing", () => {
  assert.equal(shellReloadDelay({ ...idle, pending: false }), null);
});

test("an app left alone adopts the deploy", () => {
  assert.equal(shellReloadDelay(idle), 0);
});

test("an app that is off screen adopts it without waiting for a pause", () => {
  assert.equal(shellReloadDelay({ ...idle, hidden: true, idleFor: 0 }), 0);
});

test("a running turn and unsent text both hold the reload back", () => {
  assert.equal(shellReloadDelay({ ...idle, busy: true }), null);
  assert.equal(shellReloadDelay({ ...idle, editing: true }), null);
  // Not even an app that is off screen may discard those.
  assert.equal(shellReloadDelay({ ...idle, hidden: true, busy: true }), null);
  assert.equal(shellReloadDelay({ ...idle, hidden: true, editing: true }), null);
});

test("an app in use re-decides after the remaining pause", () => {
  assert.equal(shellReloadDelay({ ...idle, idleFor: 500 }), SHELL_RELOAD_IDLE_MS - 500);
});
