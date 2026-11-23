import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// A send with an IME composition still open (a phone keyboard keeps the last
// syllable or word composing when the send disc is tapped). The keyboard is
// played over CDP; like Android's, it keeps its composing span until its input
// session restarts, which Chromium does when the focused field changes. A
// span it still holds when the page empties the field is written back in.
const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };
const PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const TYPED = 'Hello 안녕하세';
const COMPOSING = '요';

test('a send with an IME composition open leaves the field empty in every frame', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir,
      loader: 'tsx',
      contents: `
        import React, { useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { isComposerComposing, useComposerIme } from './use-composer-ime';
        import { useComposerSubmission } from './use-composer-submission';
        import { useComposerKeyboard } from './use-composer-keyboard';
        import { holdFieldFocusOnPress } from './surface-input-focus';

        const noop = () => {};
        const ref = (current) => ({ current });
        function Harness() {
          const textarea = useRef(null);
          const [draft, setDraft] = useState('');
          const [, setSubmitting] = useState(false);
          const [, setRecovery] = useState(0);
          const refs = useRef(null);
          refs.current ??= {
            draftRef: ref(''),
            attachmentsRef: ref([]),
            pendingLoads: ref(0),
            transitioningRef: ref(false),
            composingRef: ref(false),
            suppressRef: ref(false),
            submittingRef: ref(false),
            submissionRetryRef: ref(null),
            mountedRef: ref(true),
            navigation: ref({ index: -1, seed: '' }),
            escapeClearAt: ref(0),
          };
          const r = refs.current;
          useComposerIme({
            textarea,
            composingRef: r.composingRef,
            suppressImeLineBreakRef: r.suppressRef,
            draftRef: r.draftRef,
            setDraft,
            setCaretOffset: noop,
          });
          const { send, stop } = useComposerSubmission({
            turnBusy: false,
            commandBusy: false,
            recoveryScope: 'ime-send',
            identityScope: 'ime-send',
            sessionId: 'ime-send',
            textarea,
            draftRef: r.draftRef,
            attachmentsRef: r.attachmentsRef,
            pendingLoads: r.pendingLoads,
            transitioningRef: r.transitioningRef,
            composingRef: r.composingRef,
            submittingRef: r.submittingRef,
            submissionRetryRef: r.submissionRetryRef,
            mountedRef: r.mountedRef,
            historyNavigation: r.navigation,
            setDraft,
            setSubmitting,
            setSubmissionRecoveryVersion: setRecovery,
            clearNotice: noop,
            showNotice: noop,
            setAttachmentError: (message) => message && window.__errors.push(message),
            removeAttachments: noop,
            mergeRestoredAttachments: () => '',
            restoredAttachments: () => ({ attachments: [], text: '' }),
            executeSlash: async () => true,
            rememberPrompt: noop,
            submit: async (content) => {
              window.__sent.push(content);
              return true;
            },
            abort: async () => true,
          });
          const list = { open: false, index: 0, setIndex: noop, setDismissed: noop };
          const { onKeyDown } = useComposerKeyboard({
            draft: { value: draft, set: setDraft, ref: r.draftRef, textarea, setCaretOffset: noop },
            slash: { ...list, commands: [] },
            mention: { ...list, match: null, signature: '', items: [], loading: false, setResults: noop },
            skillMention: { ...list, match: null, signature: '', results: [] },
            selector: { ...list, setOpen: noop, messages: [], openSelector: noop, rewindToMessage: async () => {} },
            history: {
              entries: [],
              navigation: r.navigation,
              seedAttachments: ref([]),
              attachmentsRef: r.attachmentsRef,
              replaceAttachments: noop,
            },
            runtime: { turnBusy: false, pendingSubmissionId: '', attachments: [], escapeClearAt: r.escapeClearAt, showNotice: noop },
            ime: { composing: r.composingRef, suppressLineBreak: r.suppressRef },
            actions: { send, stop, clearAttachments: noop },
          });
          window.__probe = () => ({
            value: textarea.current.value,
            composing: r.composingRef.current,
            tracked: isComposerComposing(textarea.current),
            active: document.activeElement?.id || document.activeElement?.tagName,
          });
          return (
            <form id="form" onSubmit={(event) => { event.preventDefault(); void send('', 'form-submit'); }}>
              <textarea
                id="field"
                ref={textarea}
                rows={1}
                value={draft}
                onChange={(event) => { r.draftRef.current = event.currentTarget.value; setDraft(event.currentTarget.value); }}
                onBlur={() => { r.composingRef.current = false; r.suppressRef.current = false; }}
                onKeyDown={onKeyDown}
              />
              <button type="submit" className="send-button" onMouseDown={holdFieldFocusOnPress}>↑</button>
            </form>
          );
        }
        window.__sent = [];
        window.__errors = [];
        createRoot(document.getElementById('root')).render(<Harness />);
      `,
    },
    bundle: true,
    format: 'iife',
    write: false,
    loader,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  const open = async ({ phone }) => {
    const page = await browser.newPage();
    if (phone) {
      await page.setUserAgent(ANDROID_UA);
      await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    } else {
      await page.setViewport({ width: 1200, height: 800 });
    }
    await page.setContent(PAGE);
    if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-mixdog-mobile-tabs', ''));
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForSelector('.send-button');
    if (phone) await page.tap('#field');
    else await page.click('#field');
    await page.keyboard.type(TYPED);
    return page;
  };

  /** The keyboard's composing span, and whether its input session restarted
   *  (the field lost focus) since the span opened. */
  const openComposition = async (page) => {
    const client = await page.createCDPSession();
    await page.evaluate(() => {
      const field = document.getElementById('field');
      window.__restarted = false;
      field.addEventListener('blur', () => (window.__restarted = true));
    });
    await client.send('Input.imeSetComposition', { text: COMPOSING, selectionStart: 1, selectionEnd: 1 });
    assert.equal(await page.evaluate(() => window.__probe().composing), true, 'the composition is open');
    let held = true;
    return {
      client,
      async commit() {
        await client.send('Input.insertText', { text: COMPOSING });
        held = false;
      },
      /** Where the page emptied the field under a span the keyboard still holds, the keyboard writes it back. */
      async writeBackIfHeld() {
        if (!held || (await page.evaluate(() => window.__restarted))) return;
        await client.send('Input.imeSetComposition', { text: COMPOSING, selectionStart: 1, selectionEnd: 1 });
        await client.send('Input.insertText', { text: COMPOSING });
      },
    };
  };

  /** Records the field's value in every frame from now on. */
  const recordFrames = (page) =>
    page.evaluate(
      () =>
        new Promise((recording) => {
          window.__frames = [];
          const field = document.getElementById('field');
          const tick = () => {
            window.__frames.push(field.value);
            if (window.__frames.length === 1) recording();
            if (window.__frames.length < 45) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })
    );

  const settle = async (page, keyboard) => {
    await page.waitForFunction(() => window.__sent.length > 0 && document.getElementById('field').value === '');
    await keyboard.writeBackIfHeld();
    await page.waitForFunction(() => window.__frames.length >= 45);
    const frames = await page.evaluate(() => window.__frames);
    const sentAt = frames.findIndex((value) => value !== TYPED + COMPOSING);
    assert.ok(sentAt > 0, `the whole text shows up to the send: ${JSON.stringify(frames)}`);
    assert.deepEqual(
      frames.slice(sentAt),
      frames.slice(sentAt).map(() => ''),
      'the field is empty in every frame from the send on'
    );
    assert.deepEqual(await page.evaluate(() => window.__sent), [TYPED + COMPOSING], 'sent once, composing part included');
    assert.deepEqual(await page.evaluate(() => window.__errors), []);
    const probe = await page.evaluate(() => window.__probe());
    assert.equal(probe.composing, false, 'the composer is not left composing');
    assert.equal(probe.tracked, false);
    // The next keystroke opens a new composition in the empty field.
    await keyboard.client.send('Input.imeSetComposition', { text: '가', selectionStart: 1, selectionEnd: 1 });
    assert.equal(await page.evaluate(() => document.getElementById('field').value), '가');
    return probe;
  };

  await t.test('phone: tapping send with the keyboard composing', async () => {
    const page = await open({ phone: true });
    const keyboard = await openComposition(page);
    await recordFrames(page);
    const box = await (await page.$('.send-button')).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const probe = await settle(page, keyboard);
    assert.equal(probe.active, 'field', 'focus stays in the field');
    await page.close();
  });

  await t.test('desktop: clicking send with a composition open', async () => {
    const page = await open({ phone: false });
    const keyboard = await openComposition(page);
    await recordFrames(page);
    await page.click('.send-button');
    const probe = await settle(page, keyboard);
    assert.equal(probe.active, 'BUTTON', 'the click keeps its native focus move');
    await page.close();
  });

  await t.test('desktop: Enter commits the composition, the next Enter sends', async () => {
    const page = await open({ phone: false });
    const keyboard = await openComposition(page);
    // The IME takes the first Enter (keyCode 229) and commits its span.
    await keyboard.client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 229,
    });
    await keyboard.commit();
    await keyboard.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.deepEqual(await page.evaluate(() => window.__sent), [], 'the committing Enter sends nothing');
    assert.equal(await page.evaluate(() => document.getElementById('field').value), TYPED + COMPOSING);
    await recordFrames(page);
    await page.keyboard.press('Enter');
    const probe = await settle(page, keyboard);
    assert.equal(probe.active, 'field');
    await page.close();
  });
});
