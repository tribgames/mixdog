import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SHELL_AUTO_BACKGROUND_MS, planShellDeadlines } from './deadline-plan.mjs';

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

test('wait_ms extends the foreground window and never shortens it', () => {
  withEnv(defaults, () => {
    assert.equal(foregroundWindow({}), DEFAULT_SHELL_AUTO_BACKGROUND_MS);
    assert.equal(foregroundWindow({ wait_ms: 60_000 }), 60_000);
    assert.equal(foregroundWindow({ wait_ms: 1000 }), DEFAULT_SHELL_AUTO_BACKGROUND_MS);
    // Capped by the foreground maximum.
    assert.equal(foregroundWindow({ wait_ms: 500_000 }), 120_000);
  });
});

test('a hard deadline inside the foreground window still bounds it', () => {
  withEnv(defaults, () => {
    assert.equal(foregroundWindow({ wait_ms: 1000, timeout_ms: 4000 }), 4000);
    assert.equal(foregroundWindow({ wait_ms: 90_000, timeout_ms: 30_000 }), 30_000);
  });
});

test('the operator override is a default wait_ms can only extend', () => {
  withEnv({ ...defaults, MIXDOG_SHELL_AUTO_BACKGROUND_MS: '30000' }, () => {
    assert.equal(foregroundWindow({}), 30_000);
    assert.equal(foregroundWindow({ wait_ms: 10_000 }), 30_000);
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
