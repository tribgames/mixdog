// A browser that lives but never prints its DevTools endpoint, for the pool's shutdown test.
// `node silent-browser.mjs <pidFile>` records its pid there, then idles until killed.
import { writeFileSync } from 'node:fs';

process.stderr.write('some startup noise, and no endpoint line\n');
writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
