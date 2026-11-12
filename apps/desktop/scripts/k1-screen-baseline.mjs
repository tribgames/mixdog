// What the Node app lists for a profile: the Node tree's own session and project listings, read from an
// UNCONVERTED copy of the profile (read only; the copy needs only <home>/projects.json and
// <home>/data/session-summaries.json{,.log} + session-hidden.json, the files Node's cold sidebar reads).
//
//   node scripts/k1-screen-baseline.mjs --node-tree=<b6f tree> --home=<unconverted home copy> --out=<baseline.json>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const tree = arg('node-tree');
const home = arg('home');
const out = arg('out');
if (!tree || !home || !out) throw new Error('usage: k1-screen-baseline.mjs --node-tree= --home= --out=');
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = join(home, 'data');
process.env.MIXDOG_PROJECTS_FILE = join(home, 'projects.json');
const load = (rel) => import(pathToFileURL(join(tree, rel)).href);
const listing = await load('src/runtime/agent/orchestrator/session/store/listing.mjs');
const projects = await load('src/runtime/shared/projects.mjs');
// session-crud.mjs listedSessions: tombstoned (closed) sessions are not listed.
const sessions = listing
  .listStoredSessionSummaries()
  .filter((s) => s.closed !== true)
  // `agent`: the row Node's sidebar leaves out (desktop-state.ts desktopSessionSummaries: `agentSession`, hidden by the sidebar).
  .map((s) => ({
    id: s.id, cwd: s.cwd, title: s.title, messageCount: s.messageCount, desktop: Boolean(s.desktopSession),
    agent: s.visibility === 'agent-only' || (s.owner === 'agent' && s.agent !== 'lead'),
  }));
const baseline = {
  source: { tree, home },
  sessions,
  projects: projects.listProjects().map((p) => ({ name: p.name, path: p.path })),
};
writeFileSync(out, JSON.stringify(baseline, null, 1));
console.log(`baseline: ${sessions.length} sessions, ${baseline.projects.length} projects -> ${out}`);
process.exit(0);
