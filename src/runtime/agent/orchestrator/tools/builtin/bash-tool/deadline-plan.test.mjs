import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SHELL_AUTO_BACKGROUND_MS, planShellDeadlines } from './deadline-plan.mjs';
import { SHELL_HOLD_DEFAULT_MS, SHELL_HOLD_MAX_MS, SHELL_HOLD_MIN_MS } from '../wait-budgets.mjs';

function withEnv(overrides, run) {
  const saved = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const defaults = { MIXDOG_SHELL_AUTO_BACKGROUND_MS: undefined, BASH_MAX_TIMEOUT_MS: undefined };
const foregroundWindow = (args) => planShellDeadlines({ args, backgroundOnTimeout: true }).autoBackgroundMs;

test('the default hold is the single shell-hold budget', () => {
  withEnv(defaults, () => {
    assert.equal(DEFAULT_SHELL_AUTO_BACKGROUND_MS, SHELL_HOLD_DEFAULT_MS);
    assert.equal(foregroundWindow({}), SHELL_HOLD_DEFAULT_MS);
  });
});

test('wait_ms picks a different hold, clamped to the published range', () => {
  withEnv(defaults, () => {
    assert.equal(foregroundWindow({ wait_ms: 20_000 }), 20_000);
    assert.equal(foregroundWindow({ wait_ms: 5_000 }), 5_000);
    assert.equal(foregroundWindow({ wait_ms: 300_000 }), 300_000, 'a hold past the 120 s foreground cap is kept');
    assert.equal(foregroundWindow({ wait_ms: 5_000_000 }), SHELL_HOLD_MAX_MS);
    assert.equal(foregroundWindow({ wait_ms: 10 }), SHELL_HOLD_MIN_MS);
  });
});

test('timeout_ms stays the hard kill: a deadline inside the hold bounds it and is not promoted', () => {
  withEnv(defaults, () => {
    const plan = planShellDeadlines({ args: { timeout_ms: 4000 }, backgroundOnTimeout: true });
    assert.equal(plan.autoBackgroundMs, 4000);
    assert.equal(plan.timeout, 4000);
    assert.equal(plan.promoteAtTimeout, false);
    const long = planShellDeadlines({ args: { timeout_ms: 300_000 }, backgroundOnTimeout: true });
    assert.equal(long.autoBackgroundMs, SHELL_HOLD_DEFAULT_MS);
    assert.equal(long.backgroundDeadlineMs, 300_000, 'the promoted job inherits the hard deadline');
  });
});

test('background:true starts in the background at once', () => {
  withEnv(defaults, () => {
    assert.equal(foregroundWindow({ background: true }), 1);
    assert.equal(foregroundWindow({ background: true, wait_ms: 90_000 }), 1);
  });
});

test('the operator override replaces the default hold; wait_ms still wins', () => {
  withEnv({ ...defaults, MIXDOG_SHELL_AUTO_BACKGROUND_MS: '20000' }, () => {
    assert.equal(foregroundWindow({}), 20_000);
    assert.equal(foregroundWindow({ wait_ms: 45_000 }), 45_000);
  });
  // 0 disables the default promotion; an explicit wait_ms still arms one.
  withEnv({ ...defaults, MIXDOG_SHELL_AUTO_BACKGROUND_MS: '0' }, () => {
    assert.equal(foregroundWindow({}), 0);
    assert.equal(foregroundWindow({ wait_ms: 20_000 }), 20_000);
  });
});

test('disabled background tasks keep every command in the foreground', () => {
  withEnv(defaults, () => {
    assert.equal(planShellDeadlines({ args: { wait_ms: 60_000 }, backgroundOnTimeout: false }).autoBackgroundMs, 0);
  });
});
