// Preloaded (NODE_OPTIONS=--require) into the JS workers of a built mixdogd during the phone-scm replay.
//  1. Every attempt of the worker to start a program is appended, started or not, to the file named in MIXDOG_SCM_DEBUG_ATTEMPTS:
//     one line when it is attempted ({id, program, args, started}) and one when a started program exits ({id, exit}). It wraps the
//     one place every `child_process` start passes through, so Node's own code runs unchanged.
//  2. The world has no network: a download (the font provisioner of a LibreOffice install fetches from raw.githubusercontent.com)
//     fails as it does for Node's recording, where that module does not load at all.
const { appendFileSync } = require('node:fs');
const { ChildProcess } = require('node:child_process');

const file = process.env.MIXDOG_SCM_DEBUG_ATTEMPTS;
const start = ChildProcess.prototype.spawn;
let count = 0;
ChildProcess.prototype.spawn = function spawn(options) {
  const result = start.call(this, options);
  if (file) {
    const id = `${process.pid}:${(count += 1)}`;
    const started = this.pid !== undefined;
    appendFileSync(file, `${JSON.stringify({ id, program: String(options.file), args: (options.args ?? []).slice(1).map(String), started })}\n`);
    if (started) this.once('exit', (code) => appendFileSync(file, `${JSON.stringify({ id, exit: code })}\n`));
  }
  return result;
};
globalThis.fetch = () => Promise.reject(new Error('the phone-scm world has no network'));
