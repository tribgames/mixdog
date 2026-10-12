// Loads the node-pty shipped in a packaged Linux app and runs a real PTY
// command, under the app's own Electron runtime (ELECTRON_RUN_AS_NODE=1):
//   ELECTRON_RUN_AS_NODE=1 <unpacked>/mixdog-desktop linux-pty-check.cjs <resourcesDir>
const { join } = require('node:path');
const resources = process.argv[2];
if (!resources) throw new Error('usage: linux-pty-check.cjs <resourcesDir>');
const pty = require(join(resources, 'app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch'));
const term = pty.spawn('/bin/sh', ['-c', 'echo pty-ok-$((6*7))'], { name: 'xterm', cols: 80, rows: 24 });
let out = '';
term.onData((data) => {
  out += data;
});
const timer = setTimeout(() => {
  console.error(`PTY CHECK FAIL: timeout, output=${JSON.stringify(out)}`);
  process.exit(1);
}, 10000);
term.onExit(() => {
  clearTimeout(timer);
  if (!out.includes('pty-ok-42')) {
    console.error(`PTY CHECK FAIL: output=${JSON.stringify(out)}`);
    process.exit(1);
  }
  console.log(`PTY CHECK OK (electron ${process.versions.electron}, abi ${process.versions.modules})`);
});
