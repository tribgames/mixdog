// terminal/ensure makes a tab, terminal/attach subscribes its `process:<id>` feed, and typed input comes back as
// process/outputDelta on that feed.
import { tmpdir } from 'node:os';

export const name = 'terminal ensure and output';

const decode = (params) => Buffer.from(String(params?.bytesB64 ?? ''), 'base64').toString('utf8');

export async function run({ env, outputMs = 30_000 }) {
  const { core } = env;
  const ensured = await core.request('terminal/ensure', { options: { cwd: tmpdir() } });
  const id = ensured?.id ?? ensured?.tabId;
  if (typeof id !== 'string' || !id) throw new Error(`terminal/ensure answered no tab id: ${JSON.stringify(ensured).slice(0, 200)}`);
  let received = '';
  let wake = () => {};
  const stop = core.client.on((event) => {
    if (event.type !== 'notification' || event.notification.method !== 'process/outputDelta') return;
    if (event.notification.feed?.id !== `process:${id}`) return;
    received += decode(event.notification.params);
    wake();
  });
  try {
    await core.request('terminal/attach', { tabId: id });
    core.client.notify('terminal/input', { tabId: id, data: 'echo mixdog-live-smoke\r' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no output with the typed text on process:${id} within ${outputMs} ms (got ${received.length} characters)`)), outputMs);
      wake = () => {
        if (!/mixdog-live-smoke/.test(received)) return;
        clearTimeout(timer);
        resolve();
      };
      wake();
    });
    return `tab ${id}: ${received.length} characters of output, the typed text came back`;
  } finally {
    stop();
    await core.request('terminal/dispose', { tabId: id }).catch(() => {});
  }
}
