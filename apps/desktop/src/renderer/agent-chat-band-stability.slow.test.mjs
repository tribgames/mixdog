import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { AgentTypingRow } from './agent-chat-row';
  import { defaultAgentAvatar } from '../shared/core-src/runtime/shared/agent-avatar.mjs';

  const member = (name) => ({ id: name ? 'bot' : '', name, avatar: defaultAgentAvatar('bot') });
  // Longer than one line on either width (it would wrap to two or three lines if the name could wrap).
  const LONG = 'Quarterly planning and release coordination assistant of the whole group, second shift. '.repeat(4).trim();
  const cases = { short: member('Bench'), long: member(LONG), deciding: member('') };
  window.mountFixture = () => createRoot(document.getElementById('root')).render(
    <section className="conversation" data-chat-mode="agent">
      <div className="thread">
        {Object.entries(cases).map(([key, who]) => (
          <div key={key} data-case={key}><AgentTypingRow member={who} lead deciding={key === 'deciding'} /></div>
        ))}
      </div>
    </section>
  );
  window.measure = () => Object.fromEntries([...document.querySelectorAll('[data-case]')].map((holder) => {
    const name = holder.querySelector('.mx-chat-name');
    return [holder.dataset.case, {
      band: holder.querySelector('.mx-chat-row').getBoundingClientRect().height,
      name: name.getBoundingClientRect().height,
      clipped: name.scrollWidth > name.clientWidth,
      title: name.getAttribute('title'),
      text: name.textContent,
    }];
  }));
`;

let built = null;
const buildFixture = () =>
  (built ??= Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'agent-chat-band-stability.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader,
      plugins: [
        {
          name: 'worker-stub',
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
          },
        },
      ],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'agent-chat-band-stability.css',
      bundle: true,
      write: false,
      loader,
    }),
  ]));

async function measured(t, { width, phone }) {
  const [bundle, styles] = await buildFixture();
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  await page.setViewport({ width, height: 700 });
  await page.setContent(
    `<!doctype html><html ${phone ? 'data-mixdog-mobile-tabs' : ''}><head></head><body><div class="app-shell"><div class="desktop-body"><main class="workspace"><div id="root" style="display:contents"></div></main></div></div></body></html>`
  );
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  const chatCss = bundle.outputFiles.find((file) => file.path.endsWith('.css'));
  if (chatCss) await page.addStyleTag({ content: chatCss.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(() => window.mountFixture());
  await page.waitForSelector('[data-case="deciding"] .mx-chat-row', { timeout: 10_000 }).catch((error) => {
    throw new Error(errors.join('\n') || error.message);
  });
  const sizes = await page.evaluate(() => window.measure());
  assert.deepEqual(errors, []);
  return sizes;
}

for (const [label, viewport] of [
  ['desktop', { width: 1100, phone: false }],
  ['phone', { width: 360, phone: true }],
]) {
  test(`typing band (${label}): a short name, a long name and the hand-off paint the band at one height`, async (t) => {
    const sizes = await measured(t, viewport);
    const { short, long, deciding } = sizes;
    assert.ok(Math.abs(long.band - short.band) <= 0.5, `long name band ${long.band}px vs ${short.band}px`);
    assert.ok(Math.abs(deciding.band - short.band) <= 0.5, `hand-off band ${deciding.band}px vs ${short.band}px`);
    assert.ok(
      Math.abs(long.name - short.name) <= 0.5 && Math.abs(deciding.name - short.name) <= 0.5,
      'one name line each'
    );
    assert.ok(short.name > 0, 'the name line has height');
    // The long name is cut, not wrapped, and stays whole for hover and assistive technology.
    assert.equal(long.clipped, true);
    assert.equal(long.title, long.text);
    assert.equal(short.clipped, false);
  });
}
