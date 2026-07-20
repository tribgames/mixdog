const wd = setTimeout(() => {
  console.error('=== WATCHDOG 45s: active resources:', JSON.stringify(process.getActiveResourcesInfo()));
  process.exit(99);
}, 45000);
await import('./compact-smoke.mjs');
clearTimeout(wd);
console.error('=== script import completed normally');
