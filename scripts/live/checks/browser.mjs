// browser/command navigates the desktop's browser to a local fixture page and the page's title is read back.
import { browserCommand } from '../lib/core-client.mjs';

export const name = 'browser navigate and title';

export async function run({ env }) {
  const url = env.fixtures.url('/form');
  const navigated = await browserCommand(env.core, 'navigate', { url });
  let seen = JSON.stringify(navigated);
  if (!/lat form/.test(seen)) seen = JSON.stringify(await browserCommand(env.core, 'snapshot', {}));
  if (!/lat form/.test(seen)) throw new Error(`the page title "lat form" was not read after navigating to ${url}: ${seen.slice(0, 300)}`);
  return `navigated to ${url}; title "lat form" read`;
}
