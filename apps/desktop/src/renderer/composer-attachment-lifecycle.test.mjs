import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

// The mounted Composer's clipboard intake (#135) and the lifecycle of unsent
// attachments across session switches, sends, deletions and remounts (#139).
const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'sessionStorage'],
  globals: {
    // Files are Node's (jsdom's Blob has no arrayBuffer), so reading is Node's too.
    FileReader: class {
      readAsDataURL(blob) {
        void blob.arrayBuffer().then(
          (buffer) => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onload?.();
          },
          () => this.onerror?.()
        );
      }
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
test.after(() => restore());
Object.defineProperty(window.navigator, 'userAgent', { value: 'Electron' });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const submitted = [];
// Composer notices and errors leave through the toast lane.
const toasts = [];
window.addEventListener('mixdog:desktop-toast', (event) => toasts.push(event.detail.text));
window.mixdogDesktop = {
  invokeCapability: async (request) => {
    if (request.capability === 'skillsStatus') return { value: { skills: [] } };
    return request.capability === 'getVoiceStatus' ? { value: { installed: false } } : { value: {} };
  },
  readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: { skills: [] } })),
  searchProjectFiles: async () => [],
  rendererDiagnostic() {},
};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('./Composer.tsx');
const { forgetComposerScope, noteDraftPromotion } = await import('./composer-draft.ts');
const { purgeRemovedSessionPreviews } = await import('./session-catalog-cache.ts');

const scopeProps = (id) => ({ historyScope: id, identityScope: id, recoveryScope: id, sessionId: id });
const baseProps = {
  turnBusy: false,
  commandBusy: false,
  transitioning: false,
  focusRequest: 0,
  projectScope: 'C:/project',
  hasConversation: true,
  provider: 'openai-oauth',
  model: 'test-model',
  effort: 'medium',
  fast: false,
  fastCapable: false,
  paneActive: true,
  submit: async (content) => {
    submitted.push(content);
    return true;
  },
  abort: async () => {},
  invokeResult: (action) => action(),
  applySnapshot() {},
  onNewTask() {},
  onResumeSession() {},
  onOpenSessions() {},
  onOpenProjects() {},
  onOpenSettings() {},
  onOpenCommandSurface() {},
  dropTargetRef: { current: null },
};

const settle = (ms = 30) => act(async () => new Promise((resolve) => window.setTimeout(resolve, ms)));
const input = () => document.querySelector('textarea');
const chipNames = () => Array.from(document.querySelectorAll('.composer-attachments img'), (image) => image.alt);
const chipCount = () => document.querySelectorAll('.composer-attachments > *').length;

function mountComposer(id, extraProps = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  let root = createRoot(host);
  const render = (nextId) =>
    act(async () => root.render(React.createElement(Composer, { ...baseProps, ...extraProps, ...scopeProps(nextId) })));
  return {
    render,
    unmount: () => act(async () => root.unmount()),
    remount: async (nextId) => {
      root = createRoot(host);
      await render(nextId);
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
    start: () => render(id),
  };
}

function clipboardOf({ text = '', html = '', files = [] }) {
  const items = [
    ...(text ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : []),
    ...(html ? [{ kind: 'string', type: 'text/html', getAsFile: () => null }] : []),
    ...files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  ];
  const data = { 'text/plain': text, 'text/html': html };
  return { items, files, types: items.map((item) => item.type), getData: (type) => data[type] ?? '' };
}

async function paste(clipboard) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboard });
  await act(async () => {
    input().dispatchEvent(event);
  });
  await settle();
  return event;
}

const image = (name) => new File(['png'], name, { type: 'image/png' });
const attachImage = (name) => paste(clipboardOf({ files: [image(name)] }));

test('#135 text copied from Word/Excel/browsers (text + html + rendered image) pastes as text, not an image', async () => {
  const mounted = mountComposer('paste-rich');
  try {
    await mounted.start();
    const rich = (text) =>
      clipboardOf({ text, html: `<table><tr><td>${text}</td></tr></table>`, files: [image('image.png')] });

    // Short text: the native paste inserts it; nothing is intercepted or attached.
    const short = await paste(rich('cell A1\tcell B1'));
    assert.equal(short.defaultPrevented, false);
    assert.equal(chipCount(), 0);

    // Long text folds into ONE pasted-text chip, never an image chip.
    const long = await paste(rich('row of a spreadsheet\n'.repeat(60)));
    assert.equal(long.defaultPrevented, true);
    assert.equal(chipCount(), 1);
    assert.deepEqual(chipNames(), []);
    assert.match(document.querySelector('.composer-attachments').textContent, /Paste/);
  } finally {
    await mounted.cleanup();
  }
});

test('#135 trade-off: any non-blank text/plain wins over an image (a copied image carrying its alt text or URL pastes the text)', async () => {
  const mounted = mountComposer('paste-alt');
  try {
    await mounted.start();
    const event = await paste(clipboardOf({ text: 'https://example.test/cat.png', files: [image('cat.png')] }));
    // Short text is left to the native paste: nothing intercepted, no chip.
    assert.equal(event.defaultPrevented, false);
    assert.equal(chipCount(), 0);
    // Whitespace-only text is no text: the image attaches.
    await paste(clipboardOf({ text: '  \n', files: [image('blank-text.png')] }));
    assert.deepEqual(chipNames(), ['blank-text.png']);
  } finally {
    await mounted.cleanup();
  }
});

test('#135 a clipboard with only a file (screenshot, Explorer copy) still attaches', async () => {
  const mounted = mountComposer('paste-image-only');
  try {
    await mounted.start();
    const event = await paste(clipboardOf({ files: [image('screenshot.png')] }));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(chipNames(), ['screenshot.png'], toasts.join('\n'));
  } finally {
    await mounted.cleanup();
  }
});

test('#139 unsent attachments return to their session after a switch and never show in the other', async () => {
  const mounted = mountComposer('switch-a');
  try {
    await mounted.start();
    await attachImage('a.png');
    assert.deepEqual(chipNames(), ['a.png']);

    await mounted.render('switch-b');
    assert.equal(chipCount(), 0);
    await attachImage('b.png');
    assert.deepEqual(chipNames(), ['b.png']);

    await mounted.render('switch-a');
    assert.deepEqual(chipNames(), ['a.png']);
    await mounted.render('switch-b');
    assert.deepEqual(chipNames(), ['b.png']);
    await mounted.render('switch-a');
    assert.deepEqual(chipNames(), ['a.png']);
  } finally {
    await mounted.cleanup();
  }
});

test('#139 sending clears the attachments for good, also across later switches', async () => {
  const mounted = mountComposer('send-a');
  try {
    await mounted.start();
    await attachImage('sent.png');
    submitted.length = 0;
    await act(async () => {
      document
        .querySelector('form.composer')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    assert.equal(submitted.length, 1);
    assert.equal(
      submitted[0].some((part) => part.type === 'image'),
      true
    );
    assert.equal(chipCount(), 0);

    await mounted.render('send-b');
    await mounted.render('send-a');
    assert.equal(chipCount(), 0);
  } finally {
    await mounted.cleanup();
  }
});

test('#139 a session missing from a catalog push keeps its parked draft and attachments when it reappears', async () => {
  const mounted = mountComposer('push-a');
  try {
    await mounted.start();
    await attachImage('parked.png');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), 'parked words');
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await mounted.render('push-b');
    // An (empty or partial) listing evicts previews but is no proof of deletion.
    const row = (id) => ({ id });
    purgeRemovedSessionPreviews([row('push-a'), row('push-b')], []);
    purgeRemovedSessionPreviews([row('push-a'), row('push-b')], [row('push-b')]);
    await mounted.render('push-a');
    assert.deepEqual(chipNames(), ['parked.png']);
    assert.equal(input().value, 'parked words');
    // Shown when it vanishes and reappears: its pane closing still parks it.
    purgeRemovedSessionPreviews([row('push-a')], []);
    await mounted.unmount();
    await mounted.remount('push-a');
    assert.deepEqual(chipNames(), ['parked.png']);
    assert.equal(input().value, 'parked words');
  } finally {
    await mounted.cleanup();
  }
});

test('#139 a confirmed session delete drops its parked attachments, even when its pane closes afterwards', async () => {
  const mounted = mountComposer('gone-a');
  try {
    await mounted.start();
    await attachImage('parked.png');
    await mounted.render('gone-b');
    forgetComposerScope('gone-a');
    await mounted.render('gone-a');
    assert.equal(chipCount(), 0);

    // Deleted while still shown: the tab closes AFTER the deletion signal and
    // parks what the composer held; that must not bring it back.
    await attachImage('shown.png');
    assert.deepEqual(chipNames(), ['shown.png']);
    forgetComposerScope('gone-a');
    await mounted.render('gone-c');
    await mounted.render('gone-a');
    assert.equal(chipCount(), 0);
    await mounted.unmount();
    await mounted.remount('gone-a');
    assert.equal(chipCount(), 0);
  } finally {
    await mounted.cleanup();
  }
});

test('#139 unmounting and mounting the composer again keeps the draft and attachments of its session', async () => {
  const mounted = mountComposer('remount-a');
  try {
    await mounted.start();
    await attachImage('kept.png');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), 'unsent words');
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await mounted.unmount();
    assert.equal(chipCount(), 0);

    await mounted.remount('remount-a');
    assert.deepEqual(chipNames(), ['kept.png']);
    assert.equal(input().value, 'unsent words');

    // Another session's composer, mounted afresh, does not inherit them.
    await mounted.unmount();
    await mounted.remount('remount-b');
    assert.equal(chipCount(), 0);
  } finally {
    await mounted.cleanup();
  }
});

const typeText = (text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), text);
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const sendForm = () =>
  act(async () => {
    document
      .querySelector('form.composer')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });

test('a New task promoted to its session carries the chips attached while its first send was in flight', async () => {
  // The acknowledgement is held, as it is while the host mints the session.
  const acknowledge = Promise.withResolvers();
  const mounted = mountComposer('draft:promote-a', { draftMode: true, submit: () => acknowledge.promise });
  try {
    await mounted.start();
    await typeText('first message');
    await sendForm();
    await attachImage('late.png');
    assert.deepEqual(chipNames(), ['late.png']);

    // The acknowledgement promotes the pane: same composer, identity moves
    // from the draft to the session this submission minted.
    noteDraftPromotion('promote-a', 'sess_promote_a');
    await mounted.render('sess_promote_a');
    assert.deepEqual(chipNames(), ['late.png']);
    acknowledge.resolve(true);
    await settle();

    // A chip added after the promotion shares the composer with the carried one.
    await attachImage('later.png');
    assert.deepEqual(chipNames(), ['late.png', 'later.png']);
  } finally {
    await mounted.cleanup();
  }
});

test('switching a sending New task to an unrelated session leaves its chips parked under the draft', async () => {
  const acknowledge = Promise.withResolvers();
  const mounted = mountComposer('draft:carry-f', { draftMode: true, submit: () => acknowledge.promise });
  try {
    await mounted.start();
    await typeText('first message');
    await sendForm();
    await attachImage('mine.png');
    // The user opens an existing session while the first send is in flight;
    // the session this submission mints is a different one.
    noteDraftPromotion('carry-f', 'sess_minted_f');
    await mounted.render('sess_unrelated_f');
    assert.equal(chipCount(), 0, 'the unrelated session never shows the draft chips');
    // Back on the draft the chips are still there, parked.
    await mounted.render('draft:carry-f');
    assert.deepEqual(chipNames(), ['mine.png']);
    // The promotion to the session that WAS minted still carries them.
    await mounted.render('sess_minted_f');
    assert.deepEqual(chipNames(), ['mine.png']);
  } finally {
    acknowledge.resolve(true);
    await mounted.cleanup();
  }
});

test('an in-flight draft with no recorded promotion parks its chips on any switch', async () => {
  const acknowledge = Promise.withResolvers();
  const mounted = mountComposer('draft:carry-g', { draftMode: true, submit: () => acknowledge.promise });
  try {
    await mounted.start();
    await typeText('first message');
    await sendForm();
    await attachImage('mine.png');
    await mounted.render('sess_unrelated_g');
    assert.equal(chipCount(), 0);
  } finally {
    acknowledge.resolve(true);
    await mounted.cleanup();
  }
});

test('a plain switch away from an idle draft parks its chips with it', async () => {
  const mounted = mountComposer('draft:carry-b', { draftMode: true });
  try {
    await mounted.start();
    input().focus();
    await attachImage('parked.png');
    await mounted.render('sess_carry_b');
    assert.equal(chipCount(), 0);
    await mounted.render('draft:carry-b');
    assert.deepEqual(chipNames(), ['parked.png']);
  } finally {
    await mounted.cleanup();
  }
});

test('a fresh New task opens clean even while the previous draft is sending', async () => {
  const acknowledge = Promise.withResolvers();
  const mounted = mountComposer('draft:carry-d', { draftMode: true, submit: () => acknowledge.promise });
  try {
    await mounted.start();
    await typeText('go');
    await sendForm();
    await attachImage('typed.png');
    await mounted.render('draft:carry-e');
    assert.equal(chipCount(), 0);
  } finally {
    acknowledge.resolve(true);
    await mounted.cleanup();
  }
});
