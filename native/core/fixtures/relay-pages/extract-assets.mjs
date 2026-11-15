// One-off extraction of the page templates from the Node pages: node extract-assets.mjs <relay lib dir> <assets dir>.
// Each template is the Node page with the values Node inserts replaced by @@NAME@@ markers.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [lib, out] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(lib, name)).href);
const { LOGO_SRC, PAGE_BASE_CSS, PAIRING_CSS, sendConnectPage } = await load('connect-page.mjs');
const { renderAppPage } = await load('app-page.mjs');
const { renderUpdatePcPage } = await load('update-pc-page.mjs');

let connect = '';
sendConnectPage({ method: 'GET' }, { writeHead: () => ({ end: (html) => (connect = html) }) });
const mark = (html) => {
  const parts = html.split(`${PAGE_BASE_CSS}\n${PAIRING_CSS}`);
  if (parts.length !== 2) throw new Error('css block not found once');
  return parts.join('@@PAGE_BASE_CSS@@\n@@PAIRING_CSS@@').split(LOGO_SRC).join('@@LOGO_SRC@@');
};
const write = (name, text) => writeFileSync(join(out, name), text);
write('connect.html', mark(connect));
write('app.html', mark(renderAppPage('@@ANDROID_URL@@')));
write('update-pc.html', mark(renderUpdatePcPage({ current: '@@CURRENT@@', min: '@@MIN@@' })));
write('pairing.css', PAIRING_CSS);
write('logo.svg', decodeURIComponent(LOGO_SRC.split(',')[1]));
