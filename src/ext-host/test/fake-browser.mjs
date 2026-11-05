// Stands in for Chromium in the pool's tests: prints its DevTools endpoint on stderr and stays
// alive until killed or its stdin closes.
process.stderr.write('some startup noise\n');
process.stderr.write(`DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake-${process.pid}\n`);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
