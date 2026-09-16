/** Live Chromium checks for pre-dispatch waiting and selected-page takeover. */
import assert from 'node:assert/strict';
import { webContents } from 'electron';
import type { BrowserHost } from './host';
import type { BrowserCommand } from './command';
import { pause } from './settle';

export async function runBrowserActionabilityScenarios(
  host: BrowserHost,
  origin: string,
  send: (input: Record<string, unknown>) => Promise<{ text: string }>
): Promise<void> {
  const sessionId = 'browser-actionability-integration';
  const command = (input: BrowserCommand) =>
    send({
      ...input,
      session_id: sessionId,
      turn_id: 1,
    });
  try {
    await command({ action: 'navigate', url: `${origin}/root`, background: true, tab: 'stability' });
    await command({ action: 'open', tab: 'stability' });
    const frame = await host.browserPageFrame(sessionId);
    const guest = webContents.fromId(frame.webContentsId);
    assert.ok(guest);

    await guest.executeJavaScript(`(() => {
      document.body.innerHTML = '';
      document.body.dataset.clicks = '0';
      setTimeout(() => {
        const button = document.createElement('button');
        button.textContent = 'Delayed target';
        button.onclick = () => document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1);
        document.body.append(button);
      }, 400);
    })()`);
    await command({ action: 'click', target: { role: 'button', name: 'Delayed target', exact: true } });
    assert.equal(await guest.executeJavaScript('document.body.dataset.clicks'), '1');

    await guest.executeJavaScript(`(() => {
      document.body.innerHTML = '<button id="button">Covered target</button><div id="overlay" style="position:fixed;inset:0;z-index:999;background:white">Loading</div>';
      document.body.dataset.clicks = '0';
      document.getElementById('button').onclick = () => document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1);
      setTimeout(() => document.getElementById('overlay').remove(), 400);
    })()`);
    await command({ action: 'click', target: { role: 'button', name: 'Covered target', exact: true } });
    assert.equal(await guest.executeJavaScript('document.body.dataset.clicks'), '1');

    await guest.executeJavaScript(`(() => {
      document.body.innerHTML = '<input id="email" aria-label="Email" disabled>';
      document.body.dataset.edits = '0';
      const field = document.getElementById('email');
      field.oninput = () => document.body.dataset.edits = String(Number(document.body.dataset.edits) + 1);
      setTimeout(() => field.disabled = false, 400);
    })()`);
    await command({ action: 'fill', target: { role: 'textbox', name: 'Email', exact: true }, text: 'ready' });
    assert.equal(await guest.executeJavaScript('document.getElementById("email").value'), 'ready');
    assert.equal(await guest.executeJavaScript('document.body.dataset.edits'), '1');

    // Both explicit and tab-less agent commands must yield on this selected
    // support page. Never bypass an unfinished input to achieve takeover.
    for (const target of [{ tab: 'stability' }, {}]) {
      await guest.executeJavaScript(`(() => {
        const field = document.getElementById('email');
        field.value = '';
        field.focus();
      })()`);
      let settled = false;
      const agent = command({ action: 'click', target: { role: 'button', name: 'Absent target' }, ...target });
      const cancelled = assert.rejects(agent, /interrupted by local user input/).then(() => {
        settled = true;
      });
      await pause(100);
      assert.equal(settled, false, 'the agent must be waiting, not already rejected');
      await host.browserPageControl(sessionId, { type: 'text', text: 'human', documentId: frame.documentId });
      await cancelled;
      assert.equal(await guest.executeJavaScript('document.getElementById("email").value'), 'human');
      await pause(1_100);
    }
  } finally {
    host.releaseSession(sessionId);
  }
}
