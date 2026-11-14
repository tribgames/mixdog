// The desktop's host role is visible through the core: the `hostState` section holds a row the desktop published, or
// `notify/state` says the host answered (its `supported` is the desktop host's `host/notification/status`, false with no host).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const name = 'host claim present';

export async function run({ env, deadlineMs = 60_000 }) {
  const { core } = env;
  await core.client.subscribeApp();
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const rows = core.client.store.sections('hostState');
    if (rows.length) return `hostState rows: ${rows.map((row) => row.key ?? '(unkeyed)').join(', ')}`;
    const state = await core.request('notify/state', {});
    if (state?.supported === true) return 'notify/state: the desktop host answered (supported: true)';
    if (Date.now() > deadline) throw new Error(`no host claim seen after ${deadlineMs} ms: hostState is empty and notify/state.supported is ${JSON.stringify(state?.supported)}`);
    await sleep(500);
  }
}
