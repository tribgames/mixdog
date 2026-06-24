'use strict';

// Single source for the hook IPC path. Centralizes an existing platform
// contract (not new heuristic). Rust mirror native/mixdog-shim/src/main.rs:34-43
// must stay in sync.
module.exports = function hookPipePath() {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\mixdog-hooks'
    : require('path').join(process.env.XDG_RUNTIME_DIR || '/tmp', 'mixdog-hooks.sock');
};
