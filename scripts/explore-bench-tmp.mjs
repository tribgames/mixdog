import { runExplore } from '../src/standalone/explore-tool.mjs';
const queries = [
  'standalone explore tool implementation entry point',
  'V4A patch format parsing/conversion implementation',
  'recall memory entries persistent store (sqlite) read/query implementation',
  'output styles: how style definitions are loaded and applied at session runtime',
  'Discord backend outbound message send implementation',
  'shell command destructive/danger policy scan before execution',
  'where does mixdog store per-user data and sessions on this machine (out of repo)',
  'channel runtime crash logging write path',
];
const t0 = Date.now();
const res = await runExplore({ query: queries, cwd: 'C:/Project/mixdog' }, { callerCwd: 'C:/Project/mixdog' });
console.log('BATCH_ELAPSED_MS', Date.now() - t0);
const txt = res.content?.[0]?.text || '';
console.log('FAILED_COUNT', (txt.match(/EXPLORATION_FAILED/g) || []).length);
process.exit(0);
