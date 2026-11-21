const isWin = process.platform === 'win32';

// win32: `detached: true` (DETACHED_PROCESS) makes the OS ignore CREATE_NO_WINDOW, so descendants open visible consoles.
// POSIX: `detached: true` makes the child a process-group leader, so the tree can be signalled.
export const detachedSpawnOpts = Object.freeze({
  windowsHide: true,
  ...(isWin ? {} : { detached: true }),
});

// Short-lived helper spawns that only need the console window hidden on win32.
export const hiddenSpawnOpts = Object.freeze({
  windowsHide: true,
});
