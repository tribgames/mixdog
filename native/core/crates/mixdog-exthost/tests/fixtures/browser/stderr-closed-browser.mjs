// A browser that lives on after closing its stderr without ever printing an endpoint, for the
// pool's shutdown race test. `node stderr-closed-browser.mjs <pidFile>` records its pid, closes
// fd 2, then idles until killed.
import { closeSync, writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
closeSync(2);
process.stdin.resume();
setInterval(() => {}, 1000);
