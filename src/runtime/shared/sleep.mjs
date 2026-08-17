// Single shared promise-sleep. Timer-holding by design: callers that must not
// keep the process alive during the wait (unref'd timers) keep a local variant.
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
