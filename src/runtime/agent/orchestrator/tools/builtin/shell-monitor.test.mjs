import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SHELL_MONITOR_INTERVAL_DEFAULT_MS,
    SHELL_MONITOR_INTERVAL_MAX_MS,
    resolveShellMonitorIntervalMs,
    startShellMonitor,
} from './shell-monitor.mjs';

test('shell monitor defaults to off and absorbs unsafe intervals as off', () => {
    assert.equal(resolveShellMonitorIntervalMs(), 0);
    assert.equal(resolveShellMonitorIntervalMs(0), 0);
    assert.equal(resolveShellMonitorIntervalMs(299_999), 0);
    assert.equal(resolveShellMonitorIntervalMs(SHELL_MONITOR_INTERVAL_MAX_MS + 1), 0);
    assert.equal(resolveShellMonitorIntervalMs(600_000), 600_000);
});

test('shell monitor keeps one non-overlapping timer and cancels cleanly', () => {
    const scheduled = [];
    const cleared = [];
    let ticks = 0;
    const cancel = startShellMonitor({
        intervalMs: 300_000,
        onTick: () => {
            ticks += 1;
            return ticks < 2;
        },
        setTimer: (fn, ms) => {
            const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
            scheduled.push(timer);
            return timer;
        },
        clearTimer: (timer) => cleared.push(timer),
    });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 300_000);
    assert.equal(scheduled[0].unrefCalled, true);
    scheduled.shift().fn();
    assert.equal(ticks, 1);
    assert.equal(scheduled.length, 1);
    scheduled.shift().fn();
    assert.equal(ticks, 2);
    assert.equal(scheduled.length, 0);
    assert.equal(cancel(), false);
    assert.equal(cleared.length, 0);
});

test('disabled shell monitor creates no timer', () => {
    const scheduled = [];
    const cancel = startShellMonitor({
        intervalMs: SHELL_MONITOR_INTERVAL_DEFAULT_MS,
        setTimer: (...args) => scheduled.push(args),
    });
    assert.equal(scheduled.length, 0);
    assert.equal(cancel(), false);
});
