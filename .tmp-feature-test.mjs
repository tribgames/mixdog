import { executeBrowserTool } from './src/runtime/browser-bridge/client.mjs';
import { executeComputerTool } from './src/runtime/computer-bridge/client.mjs';

const brief = (result) => {
  const first = (result.content || [])[0];
  const text = first?.type === 'text' ? first.text.replace(/\s+/g, ' ').slice(0, 220) : String(first?.type);
  const image = (result.content || []).some((item) => item.type === 'image') ? ' [+image]' : '';
  return `${result.isError ? 'ERROR ' : ''}${text}${image}`;
};
const run = async (label, fn) => {
  const t = Date.now();
  const result = await fn();
  console.log(`[${label} ${Date.now() - t}ms] ${brief(result)}\n`);
};

await run('browser navigate bg:news', () => executeBrowserTool({ action: 'navigate', url: 'https://example.com', background: true, tab: 'news' }));
await run('browser wait text', () => executeBrowserTool({ action: 'wait', text: 'illustrative examples', background: true, tab: 'news', timeoutMs: 8000 }));
await run('browser wait timeout', () => executeBrowserTool({ action: 'wait', text: 'THIS_TEXT_NEVER_APPEARS', background: true, tab: 'news', timeoutMs: 1500 }));
await run('browser list_tabs', () => executeBrowserTool({ action: 'list_tabs' }));
await run('browser downloads', () => executeBrowserTool({ action: 'downloads' }));
await run('browser close_tab', () => executeBrowserTool({ action: 'close_tab', tab: 'news' }));
await run('browser list_tabs after', () => executeBrowserTool({ action: 'list_tabs' }));
await run('computer list_windows', () => executeComputerTool({ action: 'list_windows' }));
await run('computer screenshot s0', () => executeComputerTool({ action: 'screenshot', screen: 0, quality: 40, maxWidth: 640 }));
