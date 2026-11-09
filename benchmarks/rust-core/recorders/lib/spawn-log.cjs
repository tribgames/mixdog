// Preloaded (NODE_OPTIONS=--require) into the JS workers of a built mixdogd during the phone-scm replay.
//  1. Every attempt of the worker to start a program is appended, started or not, to the file the core's own attempt log uses
//     (MIXDOG_SCM_DEBUG_ATTEMPTS), in the shape of mixdog-scm src/seam.rs `attempt`. It wraps the one place every `child_process`
//     start passes through, so Node's own code runs unchanged.
//  2. The world has no network: a download (the font provisioner of a LibreOffice install fetches from raw.githubusercontent.com)
//     fails as it does for Node's recording, where that module does not load at all.
const { appendFileSync } = require('node:fs');
const { ChildProcess } = require('node:child_process');

const file = process.env.MIXDOG_SCM_DEBUG_ATTEMPTS;
const start = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function spawn(options) {
  const result = start.call(this, options);
  if (file) {
    const line = { program: String(options.file), args: (options.args ?? []).slice(1).map(String), pty: false, started: this.pid !== undefined };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  }
  return result;
};
globalThis.fetch = () => Promise.reject(new Error('the phone-scm world has no network'));
