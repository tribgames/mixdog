export const SHELL_MONITOR_INTERVAL_DEFAULT_MS = 0;
export const SHELL_MONITOR_INTERVAL_MIN_MS = 300_000;
export const SHELL_MONITOR_INTERVAL_MAX_MS = 2_147_483_647;

export function isValidShellMonitorIntervalMs(value) {
    return Number.isInteger(value)
        && (value === 0
            || (value >= SHELL_MONITOR_INTERVAL_MIN_MS
                && value <= SHELL_MONITOR_INTERVAL_MAX_MS));
}

export function resolveShellMonitorIntervalMs(value) {
    if (value == null) return SHELL_MONITOR_INTERVAL_DEFAULT_MS;
    const interval = Number(value);
    return isValidShellMonitorIntervalMs(interval)
        ? interval
        : SHELL_MONITOR_INTERVAL_DEFAULT_MS;
}

export function startShellMonitor({
    intervalMs,
    onTick,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    const delay = resolveShellMonitorIntervalMs(intervalMs);
    if (delay === 0) return () => false;
    let active = true;
    let timer = null;
    const schedule = () => {
        if (!active) return;
        timer = setTimer(() => {
            timer = null;
            if (!active) return;
            let keepRunning = true;
            try {
                keepRunning = onTick?.() !== false;
            } catch {
                keepRunning = true;
            }
            if (!active || !keepRunning) {
                active = false;
                return;
            }
            schedule();
        }, delay);
        timer?.unref?.();
    };
    schedule();
    return () => {
        if (!active) return false;
        active = false;
        if (timer != null) clearTimer(timer);
        timer = null;
        return true;
    };
}
