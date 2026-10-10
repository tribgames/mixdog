import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'MutationObserver', 'navigator'],
});
const { copyTextToClipboard } = await import('./text-format.ts');
const { CopyControl } = await import('./transcript-primitives.tsx');
const { t } = await import('./i18n');
const { TranscriptRow } = await import('./transcript-row.tsx');
const { ToolActivityGroup } = await import('./transcript-tool-ui.tsx');
const { CodeDiff } = await import('./transcript-diff.tsx');
const { default: MarkdownAstBody } = await import('./MarkdownAstBody.tsx');
const { MarkdownSourceFallback } = await import('./MarkdownSourceFallback.tsx');
const { parseMarkdownToHast } = await import('./markdown-ast.ts');
const clipboard = (writeText) =>
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });

async function mount(value = '**답변**\n\n```js\nconst x = 1;\n```') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (text) =>
    act(async () => {
      root.render(
        React.createElement(CopyControl, { value: text, label: 'Copy response', className: 'response-copy' })
      );
    });
  await render(value);
  return {
    button: host.querySelector('button'),
    host,
    render,
    click: () => act(async () => host.querySelector('button').click()),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('copy preserves Markdown, waits for success, and blocks duplicate presses', async () => {
  let finish;
  const writes = [];
  clipboard((value) => {
    writes.push(value);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const value = '**한글 답변**\n\n```js\nconst x = 1;\n```';
  const view = await mount(value);
  try {
    await view.click();
    await view.click();
    assert.deepEqual(writes, [value]);
    assert.equal(view.button.hasAttribute('data-copied'), false);
    assert.equal(view.button.disabled, true);
    await act(async () => finish());
    assert.equal(view.button.dataset.copied, 'true');
    assert.equal(view.button.disabled, false);
  } finally {
    await view.cleanup();
  }
});

test('denied clipboard writes report failure without retrying and allow a new press', async () => {
  let calls = 0;
  clipboard(async () => {
    if (++calls === 1) throw new Error('denied');
  });
  document.execCommand = () => assert.fail('must not replay a rejected write');
  const view = await mount();
  try {
    await view.click();
    assert.equal(view.button.dataset.tooltip, t('Copy failed'));
    assert.equal(view.host.querySelector('[role="status"]').textContent, t('Copy failed'));
    assert.equal(view.button.hasAttribute('data-copied'), false);
    await view.click();
    assert.equal(calls, 2);
    assert.equal(view.button.dataset.copied, 'true');
  } finally {
    await view.cleanup();
  }
});

test('old message completion cannot overwrite a newer copy result', async () => {
  let finishOld;
  clipboard((value) =>
    value === 'old'
      ? new Promise((resolve) => {
          finishOld = resolve;
        })
      : Promise.reject(new Error('denied'))
  );
  const view = await mount('old');
  try {
    await view.click();
    await view.render('new');
    assert.equal(view.button.disabled, false);
    await view.click();
    await act(async () => finishOld());
    assert.equal(view.button.dataset.tooltip, t('Copy failed'));
    await view.render('');
    assert.equal(view.button.disabled, true);
    assert.equal(view.button.hasAttribute('data-copied'), false);
  } finally {
    await view.cleanup();
  }
});

test('unmounting during a write does not schedule copied feedback', async () => {
  let finish;
  clipboard(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const view = await mount();
  await view.click();
  await view.cleanup();
  const original = window.setTimeout;
  let timers = 0;
  window.setTimeout = () => {
    timers += 1;
    return 0;
  };
  try {
    await act(async () => finish());
    assert.equal(timers, 0);
  } finally {
    window.setTimeout = original;
  }
});

async function mountSurface(element) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next) =>
    act(async () => {
      root.render(next);
    });
  await render(element);
  return {
    host,
    render,
    buttons: (selector) => [...host.querySelectorAll(selector)],
    click: (selector, index = 0) => act(async () => host.querySelectorAll(selector)[index].click()),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function recordClipboard() {
  const writes = [];
  clipboard(async (value) => {
    writes.push(value);
  });
  return writes;
}

const SOURCE = '```js\nconst a = "<b>";\n\n  indent();\n```';
const CODE = 'const a = "<b>";\n\n  indent();';

test('CopyControl succeeds only when the trusted-sender clipboard-sanitized-write policy allows it', async () => {
  const { desktopPermissionAllowed } = await import('../main/permission-policy.ts');
  const trustedSender = {};
  const writes = [];
  clipboard(async (value) => {
    if (!desktopPermissionAllowed('clipboard-sanitized-write', trustedSender, trustedSender)) {
      throw new Error('NotAllowedError');
    }
    writes.push(value);
  });
  assert.equal(desktopPermissionAllowed('clipboard-read', trustedSender, trustedSender), false);
  const value = '**답변**\n\n```js\nconst x = 1;\n```';
  const view = await mountSurface(
    React.createElement(CopyControl, { value, label: 'Copy response', className: 'response-copy' })
  );
  try {
    await view.click('.response-copy');
    assert.deepEqual(writes, [value]);
    assert.equal(view.host.querySelector('.response-copy').dataset.copied, 'true');
    assert.equal(view.host.querySelector('[role="status"]').textContent, t('Copied'));
  } finally {
    await view.cleanup();
  }
});

test('response footer copy writes the exact response Markdown', async () => {
  const writes = recordClipboard();
  const text = `**답변**\n\n${SOURCE}\n\n- item`;
  const view = await mountSurface(
    React.createElement(TranscriptRow, {
      item: { kind: 'assistant', id: 'a1', text },
      completion: { kind: 'turndone', status: 'complete', elapsedMs: 1000 },
    })
  );
  try {
    await view.click('footer .response-copy');
    assert.deepEqual(writes, [text]);
  } finally {
    await view.cleanup();
  }
});

test('rich Markdown and source-fallback code blocks copy exact code, with denied-write retry', async () => {
  for (const element of [
    React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(SOURCE), copyControl: CopyControl }),
    // biome-ignore lint/correctness/useJsxKeyInIterable: fixed two-element list iterated directly, not rendered as siblings
    React.createElement(MarkdownSourceFallback, { text: SOURCE, copyControl: CopyControl }),
  ]) {
    let calls = 0;
    const writes = [];
    clipboard(async (value) => {
      writes.push(value);
      if (++calls === 1) throw new Error('denied');
    });
    const view = await mountSurface(element);
    try {
      await view.click('.markdown-code-copy');
      assert.equal(view.host.querySelector('.markdown-code-copy').dataset.tooltip, t('Copy failed'));
      await view.click('.markdown-code-copy');
      assert.deepEqual(writes, [CODE, CODE]);
      assert.equal(view.host.querySelector('.markdown-code-copy').dataset.copied, 'true');
    } finally {
      await view.cleanup();
    }
  }
});

test('streaming code block copies the latest content after it changes', async () => {
  const writes = recordClipboard();
  const view = await mountSurface(
    React.createElement(MarkdownSourceFallback, { text: '```js\nlet a', copyControl: CopyControl })
  );
  try {
    await view.click('.markdown-code-copy');
    await view.render(
      React.createElement(MarkdownSourceFallback, { text: '```js\nlet a = 1;\nlet b', copyControl: CopyControl })
    );
    assert.equal(view.host.querySelector('.markdown-code-copy').hasAttribute('data-copied'), false);
    await view.click('.markdown-code-copy');
    assert.deepEqual(writes, ['let a', 'let a = 1;\nlet b']);
  } finally {
    await view.cleanup();
  }
});

async function openToolDetails(view) {
  await view.click('.tool-activity-header');
  const row = view.host.querySelector('.tool-activity-details button, .tool-activity-item-toggle');
  if (row && !view.host.querySelector('.tool-activity-item-body')) await act(async () => row.click());
}

test('tool terminal and output copy exact command/output payloads, including changing output', async () => {
  const writes = recordClipboard();
  const bash = (result) => ({
    kind: 'tool',
    id: 'b1',
    name: 'bash',
    args: { command: 'echo "hi"\nls' },
    result,
    completedAt: 1,
  });
  const view = await mountSurface(React.createElement(ToolActivityGroup, { items: [bash('line1\n  line2')] }));
  try {
    await openToolDetails(view);
    await view.click('.tool-activity-terminal .tool-activity-copy');
    await view.render(React.createElement(ToolActivityGroup, { items: [bash('line1\n  line2\nline3')] }));
    await view.click('.tool-activity-terminal .tool-activity-copy');
    assert.deepEqual(writes, ['echo "hi"\nls\n\nline1\n  line2', 'echo "hi"\nls\n\nline1\n  line2\nline3']);
  } finally {
    await view.cleanup();
  }
});

test('tool file link is its own focusable button outside the disclosure and never toggles it', async () => {
  const view = await mountSurface(
    React.createElement(ToolActivityGroup, {
      items: [{ kind: 'tool', id: 'r1', name: 'read', args: { path: 'src/app.ts' }, result: 'line', completedAt: 1 }],
    })
  );
  try {
    await openToolDetails(view);
    const toggle = view.host.querySelector('.tool-activity-item-toggle');
    const link = view.host.querySelector('.tool-path-link');
    assert.ok(toggle && link);
    assert.equal(link.tagName, 'BUTTON');
    assert.equal(link.tabIndex, 0);
    assert.equal(link.closest('button.tool-activity-item-toggle'), null);
    assert.equal(link.parentElement.closest('button'), null);
    const before = toggle.getAttribute('aria-expanded');
    await act(async () => {
      link.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      link.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      link.click();
    });
    assert.equal(toggle.getAttribute('aria-expanded'), before);
  } finally {
    await view.cleanup();
  }
});

test('tool non-terminal output copies exactly', async () => {
  const writes = recordClipboard();
  const view = await mountSurface(
    React.createElement(ToolActivityGroup, {
      items: [
        {
          kind: 'tool',
          id: 'g1',
          name: 'grep',
          args: { pattern: 'x' },
          result: 'a.ts:1: x\n b.ts:2: x',
          completedAt: 1,
        },
      ],
    })
  );
  try {
    await openToolDetails(view);
    await view.click('.tool-activity-item-result-block .tool-activity-copy');
    assert.deepEqual(writes, ['a.ts:1: x\n b.ts:2: x']);
  } finally {
    await view.cleanup();
  }
});

test('per-file diff copy writes only that file patch, and retries after denial', async (context) => {
  const { createCanvas } = await import('@napi-rs/canvas');
  context.mock.method(window.HTMLCanvasElement.prototype, 'getContext', function (kind) {
    return createCanvas(this.width, this.height).getContext(kind);
  });
  // Exercise the loaded diff, not only its Suspense fallback.
  await import('./DiffView.lazy.tsx');
  const firstPatch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    '',
  ].join('\n');
  const secondPatch = [
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-three',
    '+four',
    '',
  ].join('\n');
  let calls = 0;
  const writes = [];
  clipboard(async (value) => {
    writes.push(value);
    if (++calls === 1) throw new Error('denied');
  });
  const view = await mountSurface(React.createElement(CodeDiff, { patch: firstPatch + secondPatch }));
  try {
    assert.equal(view.host.querySelector('.diff-loading'), null);
    assert.equal(view.buttons('.diff-copy').length, 2);
    await view.click('.diff-copy', 1);
    await view.click('.diff-copy', 1);
    await view.click('.diff-copy', 0);
    assert.deepEqual(writes, [secondPatch, secondPatch, firstPatch]);
  } finally {
    await view.cleanup();
  }
});

for (const outcome of ['success', 'false', 'throw']) {
  test(`legacy copy ${outcome} restores focus and selection and removes its temporary field`, async () => {
    clipboard();
    const editor = document.createElement('textarea');
    editor.value = 'draft message';
    document.body.append(editor);
    editor.focus();
    editor.setSelectionRange(2, 7, 'backward');
    document.execCommand = (command) => {
      assert.equal(command, 'copy');
      const temporary = document.body.lastElementChild;
      assert.equal(temporary.value, 'copied text');
      temporary.focus();
      if (outcome === 'throw') throw new Error('unavailable');
      return outcome === 'success';
    };
    try {
      if (outcome === 'success') await copyTextToClipboard('copied text');
      else await assert.rejects(copyTextToClipboard('copied text'));
      assert.equal(document.activeElement, editor);
      assert.equal(editor.selectionStart, 2);
      assert.equal(editor.selectionEnd, 7);
      assert.equal(editor.selectionDirection, 'backward');
      assert.equal(document.querySelectorAll('textarea').length, 1);
    } finally {
      editor.remove();
    }
  });
}
