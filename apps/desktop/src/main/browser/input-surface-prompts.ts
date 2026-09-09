import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import { createPolling } from '../host-harness-poll';

/** Actual dialog UI and upload transport; the host fixture supplies a native
 * picker result so this never opens an OS dialog or reads user files. */
export async function exerciseBrowserPrompts(
  guest: WebContents, shell: WebContents, log: (message: string) => void,
): Promise<void> {
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 25 });
  const hasPrompt = () => shell.executeJavaScript(`Boolean(document.querySelector('.browser-page-prompt'))`);
  const click = async (last: boolean) => {
    const point = await shell.executeJavaScript(`(() => {
      const buttons = document.querySelectorAll('.browser-page-prompt button');
      const r = buttons[${last ? 'buttons.length - 1' : '0'}].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    await eventually(hasPrompt, value => !value);
  };
  const original = await guest.executeJavaScript(`document.getElementById('agent').value`);
  for (const type of ['alert', 'confirm', 'prompt']) {
    await guest.executeJavaScript(`setTimeout(() => {
      window.promptResult = ${type}('Fixture ${type}'${type === 'prompt' ? ", 'initial'" : ''});
    }, 0); void 0`);
    await eventually(hasPrompt, Boolean);
    if (type === 'prompt') {
      await shell.executeJavaScript(`document.querySelector('.browser-page-prompt input').focus();
        document.querySelector('.browser-page-prompt input').select();`);
      await shell.debugger.sendCommand('Input.insertText', { text: '사용자 응답' });
    }
    await click(type !== 'confirm');
    if (type !== 'alert') assert.equal(await guest.executeJavaScript('window.promptResult'),
      type === 'confirm' ? false : '사용자 응답');
  }
  assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), original);
  await guest.executeJavaScript(`(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.id = 'fixture-upload'; document.body.append(input);
    input.click();
  })()`, true);
  await eventually(hasPrompt, Boolean);
  await click(true);
  assert.equal(await guest.executeJavaScript(`document.getElementById('fixture-upload').files[0].name`), 'chosen.txt');
  assert.equal(await guest.executeJavaScript(`document.getElementById('fixture-upload').files[0].text()`), 'browser upload fixture');
  await guest.executeJavaScript(`document.getElementById('fixture-upload').click()`, true);
  await eventually(hasPrompt, Boolean);
  await click(false);
  assert.equal(await guest.executeJavaScript(`document.getElementById('fixture-upload').files[0].name`), 'chosen.txt',
    'cancelling a picker must preserve a previously selected file');
  await guest.executeJavaScript(`document.getElementById('fixture-upload').remove()`);
  log('human alert/confirm/prompt answers and file selection/cancel passed without editing the page input');
}
