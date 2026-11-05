// A v1.4.5 process for the downgrade test: imports that release's session
// store (argv[2] = its file URL) on the data dir in MIXDOG_DATA_DIR, runs one
// operation (argv[3], arguments JSON in argv[4]) and prints the result as JSON.
//   probe  nothing but the import
//   seed   { sessions }  saveSession (immediate) each, then drain
//   view   { ids }       loadSession each, plus what the storage listing shows
//   write  { id, message, title }  load, append, retitle, saveSession (immediate)
const [storeUrl, op, rawArgs = '{}'] = process.argv.slice(2);
const args = JSON.parse(rawArgs);
const store = await import(storeUrl);

let out = null;
if (op === 'seed') {
  for (const session of args.sessions) store.saveSession(session, { immediate: true });
} else if (op === 'view') {
  out = {
    sessions: Object.fromEntries(args.ids.map((id) => [id, store.loadSession(id)])),
    listed: store.listStoredSessions().map((session) => session.id).sort(),
    summaries: store.listStoredSessionSummaries().map((row) => row.id).sort(),
  };
} else if (op === 'write') {
  const session = store.loadSession(args.id);
  session.messages.push(args.message);
  session.title = args.title;
  store.saveSession(session, { immediate: true });
  out = store.loadSession(args.id);
} else if (op !== 'probe') {
  throw new Error(`unknown op ${op}`);
}
await store.drainSessionStore();
process.stdout.write(JSON.stringify(out), () => process.exit(0));
