// Centralized child_process spawn/fork flag presets (win32 console-leak fix).
//
// win32 rule: DETACHED_PROCESS (Node `detached:true`) makes the OS IGNORE
// CREATE_NO_WINDOW (Node `windowsHide:true`), so every descendant allocates
// its own VISIBLE console window. On win32 we therefore NEVER set
// `detached:true` for hidden background spawns — `windowsHide` alone gives the
// child a hidden own console that descendants inherit; it survives the parent
// console closing, and Windows does not kill children on parent exit anyway.
//
// POSIX has no console concept, so `windowsHide` is a no-op there and
// `detached:true` stays REQUIRED: it makes the child a process-group leader so
// the whole tree can be signalled / tree-killed.
//
// Modeled on hermes-agent's _subprocess_compat two-mode split.
const isWin = process.platform === 'win32';

// Background daemon / process-tree spawns: hidden window everywhere, plus
// process-group detachment on POSIX only (dropped on win32 per the rule above).
export const detachedSpawnOpts = Object.freeze({
  windowsHide: true,
  ...(isWin ? {} : { detached: true }),
});

// Short-lived helper spawns that only need the console window hidden on win32.
export const hiddenSpawnOpts = Object.freeze({
  windowsHide: true,
});
