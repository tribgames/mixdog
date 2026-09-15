import assert from 'node:assert/strict';
import type { WebContents, WebFrameMain } from 'electron';
import { createPolling } from '../host-harness-poll';

/** Real Chromium composition events through the production renderer and IPC. */
export async function exerciseBrowserIme(
  shell: WebContents,
  target: WebContents | WebFrameMain,
  fieldId: string,
  restoreValue: string,
): Promise<void> {
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 25 });
  const field = `document.getElementById(${JSON.stringify(fieldId)})`;
  await target.executeJavaScript(`(() => {
    const field = ${field};
    field.value = ''; field.focus();
    window.imeEvents = [];
    window.imeListener = event => imeEvents.push({type:event.type, data:event.data, trusted:event.isTrusted});
    for (const type of ['compositionstart','compositionupdate','compositionend']) field.addEventListener(type, imeListener);
  })()`);
  await shell.executeJavaScript(`(() => {
    window.localImeEnds = [];
    window.localImeEndListener = event => localImeEnds.push({type:event.type, data:event.data, trusted:event.isTrusted});
    document.addEventListener('compositionend', localImeEndListener, true);
  })()`);
  try {
    const value = () => target.executeJavaScript(`${field}.value`);
    let committed = '';
    for (const syllable of [['ㅎ', '하', '한'], ['ㄱ', '그', '글']]) {
      for (const text of syllable) {
        await shell.debugger.sendCommand('Input.imeSetComposition', {
          text, selectionStart: text.length, selectionEnd: text.length,
        });
        await eventually(value, value => value === committed + text);
      }
      const text = syllable.at(-1)!;
      await shell.debugger.sendCommand('Input.insertText', { text });
      committed += text;
      await eventually(value, value => value === committed);
    }
    assert.equal(await value(), '한글', 'composition commits once, not once per update');
    await shell.debugger.sendCommand('Input.imeSetComposition', { text: '취', selectionStart: 1, selectionEnd: 1 });
    await eventually(value, value => value === '한글취');
    await shell.debugger.sendCommand('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await eventually(value, value => value === '한글');
    await shell.debugger.sendCommand('Input.insertText', { text: ' abc' });
    await eventually(value, value => value === '한글 abc');
    const events = await target.executeJavaScript('imeEvents') as Array<{type: string; data: string; trusted: boolean}>;
    assert.ok(events.some(event => event.type === 'compositionupdate'));
    assert.ok(events.filter(event => event.type !== 'compositionend').every(event => event.trusted),
      'composition starts and updates use native input');
    const ends = events.filter(event => event.type === 'compositionend');
    assert.deepEqual(ends.map(event => event.data), ['한', '글', '']);
    assert.deepEqual(ends, await shell.executeJavaScript('localImeEnds'),
      'forwarded commits and cancellation match the native source, including Chromium trust flags');
    assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`), 'keep editing');
  } finally {
    await shell.executeJavaScript(`document.removeEventListener('compositionend', localImeEndListener, true)`);
    await target.executeJavaScript(`(() => {
      const field = ${field};
      for (const type of ['compositionstart','compositionupdate','compositionend']) field.removeEventListener(type, imeListener);
      field.value = ${JSON.stringify(restoreValue)};
    })()`);
  }
}
