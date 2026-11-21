import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'sessionStorage'],
  globals: {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
test.after(() => restore());
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { skillMentionMatchAt } = await import('./use-composer-palettes.ts');
const {
  appliedSkillsOf,
  composerHighlightSegments,
  composerSkillCatalog,
  disabledMentionedSkills,
  filterSkillMentions,
  invalidateSkillCatalogForMutation,
  refreshSkillCatalog,
  resetSkillCatalogReadsForTests,
  skillMentionSegments,
  useSkillCatalog,
} = await import('./composer-skill-mentions.tsx');
const { Composer } = await import('./Composer.tsx');

const STATUS = {
  skills: [
    { name: 'release-notes', enabled: true, description: 'Write release notes from changes' },
    { name: 'api-review', enabled: true, description: 'Review public API changes' },
    { name: 'figma-handoff', enabled: false, description: 'Turn designs into specs' },
    { name: 'pptx', enabled: true, source: 'builtin', description: 'MODEL_ONLY' },
  ],
};

test('$ matches at the caret after start, whitespace, brackets and quotes, never inside a word', () => {
  assert.deepEqual(skillMentionMatchAt('$', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(skillMentionMatchAt('정리해서 $rel', 9), { start: 5, end: 9, query: 'rel' });
  for (const opener of ['(', '[', '{', '"', "'", '`', '\n']) {
    assert.equal(skillMentionMatchAt(`a ${opener}$x`, 5)?.query, 'x', opener);
  }
  // Caret in the middle: only the text before it counts.
  assert.deepEqual(skillMentionMatchAt('$release later', 4), { start: 0, end: 4, query: 'rel' });
  for (const text of ['price$3', 'a $HOME', '$a b', '@x$y', 'a $rel-notes!']) {
    assert.equal(skillMentionMatchAt(text, text.length), null, text);
  }
});

test('$ inside Markdown code never opens the skill palette', () => {
  const at = (text, caret = text.length) => skillMentionMatchAt(text, caret);
  // Inside a fenced block (open or closed), inline code, or a span closed after the caret.
  for (const text of ['```\n$rel', '```js\nx\n$rel', '~~~\n$rel']) {
    assert.equal(at(text), null, text);
  }
  assert.equal(at('```\n$rel\n```', 8), null);
  assert.equal(at('see `$rel` now', 9), null);
  assert.equal(at('see `` a $rel `` now', 13), null);
  // Outside code it still opens: after a closed fence or span, or an unmatched backtick.
  assert.equal(at('```\nx\n```\n$rel')?.query, 'rel');
  assert.equal(at('`code` $rel')?.query, 'rel');
  assert.equal(at('a `$rel')?.query, 'rel');
});

test('reserved mention names are never palette rows or highlighted, but stay + chip skills', () => {
  const status = {
    skills: ['home', 'path', '300', 'release-notes'].map((name) => ({ name, enabled: true, description: '' })),
  };
  const catalog = composerSkillCatalog(status);
  assert.deepEqual(
    catalog.selectable.map((skill) => skill.name),
    ['home', 'path', '300', 'release-notes']
  );
  assert.deepEqual(
    filterSkillMentions(catalog.selectable, '').map(({ skill }) => skill.name),
    ['release-notes']
  );
  assert.deepEqual(filterSkillMentions(catalog.selectable, 'ho'), []);
  const isSkill = (name) => catalog.enabled.has(name);
  assert.deepEqual(
    skillMentionSegments('$home $path $300 $release-notes', isSkill)
      .filter((s) => s.skill)
      .map((s) => s.skill),
    ['release-notes']
  );
});

test('palette filter: prefix matches first, then contains, in catalog order', () => {
  const skills = ['api-review', 'release-notes', 'pre-release', 'review'].map((name) => ({ name, description: '' }));
  assert.deepEqual(
    filterSkillMentions(skills, 'rel').map(({ skill, start }) => [skill.name, start]),
    [
      ['release-notes', 0],
      ['pre-release', 4],
    ]
  );
  assert.deepEqual(
    filterSkillMentions(skills, 'review').map(({ skill }) => skill.name),
    ['review', 'api-review']
  );
  assert.equal(filterSkillMentions(skills, '').length, 4);
});

test('catalog: enabled includes built-ins, the palette lists only custom skills, off skills are tracked', () => {
  const catalog = composerSkillCatalog(STATUS);
  assert.deepEqual(
    catalog.selectable.map((skill) => skill.name),
    ['release-notes', 'api-review']
  );
  assert.deepEqual([...catalog.enabled].sort(), ['api-review', 'pptx', 'release-notes']);
  assert.deepEqual([...catalog.disabled], ['figma-handoff']);
  assert.deepEqual(disabledMentionedSkills('$figma-handoff 로 $figma-handoff $api-review', catalog), ['figma-handoff']);
  assert.deepEqual(disabledMentionedSkills('figma$figma-handoff', catalog), []);
});

// skillsStatus as the runtime's scope decoration returns it for a session
// whose cwd is C:/project.
const SCOPED_STATUS = {
  skills: [
    { name: 'release-notes', enabled: true, scope: null, inheritedScope: null, activeHere: true },
    { name: 'elsewhere', enabled: true, scope: ['C:/other'], inheritedScope: null, activeHere: false },
    {
      name: 'plugin-here',
      enabled: true,
      scope: null,
      inheritedScope: ['C:/project'],
      activeHere: true,
      owner: { kind: 'plugin', id: 'team' },
    },
    {
      name: 'plugin-elsewhere',
      enabled: true,
      scope: null,
      inheritedScope: ['C:/other'],
      activeHere: false,
      owner: { kind: 'plugin', id: 'other' },
    },
    { name: 'image', enabled: true, source: 'builtin', scope: null, inheritedScope: null, activeHere: true },
  ],
};

test('catalog: only skills in scope here are available', () => {
  const here = composerSkillCatalog(SCOPED_STATUS);
  assert.deepEqual(
    here.selectable.map((skill) => skill.name),
    ['release-notes', 'plugin-here']
  );
  assert.deepEqual([...here.enabled].sort(), ['image', 'plugin-here', 'release-notes']);
  // Out of scope is not "off": no plain-text notice for it.
  assert.deepEqual([...here.disabled], []);
  // Status without scope decoration (older runtime) keeps the enabled rule.
  assert.deepEqual([...composerSkillCatalog(STATUS).enabled].sort(), ['api-review', 'pptx', 'release-notes']);
});

test('highlight segments keep the text verbatim and mark only recognised names', () => {
  const enabled = composerSkillCatalog(STATUS).enabled;
  const text = '$api-review 기준, 결과는 $pptx. 경로 $HOME/reports, 예산 $300, $unknown-skill, $figma-handoff';
  const segments = skillMentionSegments(text, (name) => enabled.has(name));
  assert.equal(segments.map((segment) => segment.text).join(''), text);
  assert.deepEqual(
    segments.filter((segment) => segment.skill).map((segment) => [segment.skill, segment.text]),
    [
      ['api-review', '$api-review'],
      ['pptx', '$pptx'],
    ]
  );
  assert.deepEqual(
    skillMentionSegments('', () => true),
    [{ text: '' }]
  );
});

test('slash highlight: only a whole recognised leading /command is marked, text verbatim', () => {
  const none = () => false;
  const slash = (text) =>
    composerHighlightSegments(text, none)
      .filter((segment) => segment.slash)
      .map((segment) => segment.text);
  assert.deepEqual(slash('/btw hello'), ['/btw']);
  assert.deepEqual(slash('/btw'), ['/btw']);
  assert.deepEqual(slash('/btw\nsecond line'), ['/btw']);
  assert.deepEqual(slash('  /new'), ['/new']);
  assert.deepEqual(slash('/q'), ['/q']);
  assert.deepEqual(slash('/bt'), []);
  assert.deepEqual(slash('/foo x'), []);
  assert.deepEqual(slash('/btwx hi'), []);
  assert.deepEqual(slash('/'), []);
  assert.deepEqual(slash('hello /btw'), []);
  assert.deepEqual(slash('hello\n/btw'), []);
  assert.deepEqual(slash('/btw 한글 입력'), ['/btw']);
  for (const text of ['/btw hello', '  /new x', '/foo', '/btw $pptx', 'plain', '']) {
    assert.equal(
      composerHighlightSegments(text, none)
        .map((segment) => segment.text)
        .join(''),
      text
    );
  }
  assert.deepEqual(
    composerHighlightSegments('/btw $pptx', (name) => name === 'pptx').map((s) => [s.text, !!s.slash, s.skill]),
    [
      ['/btw', true, undefined],
      [' ', false, undefined],
      ['$pptx', false, 'pptx'],
    ]
  );
});

test('appliedSkills is read defensively', () => {
  assert.deepEqual(appliedSkillsOf({ appliedSkills: ['pptx', 'pptx', '', 3, 'api-review'] }), ['pptx', 'api-review']);
  for (const item of [{}, null, { appliedSkills: 'pptx' }]) assert.deepEqual(appliedSkillsOf(item), []);
});

const composerProps = (id, overrides = {}) => ({
  turnBusy: false,
  commandBusy: false,
  transitioning: false,
  focusRequest: 0,
  historyScope: id,
  identityScope: id,
  recoveryScope: id,
  projectScope: 'C:/project',
  sessionId: id,
  hasConversation: true,
  provider: 'openai-oauth',
  model: 'test-model',
  effort: 'medium',
  fast: false,
  fastCapable: false,
  paneActive: true,
  submit: async () => true,
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
  ...overrides,
});

const typeInto = async (input, value, caret = value.length) => {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};

async function mountSkillComposer(t, id, { status = STATUS, ...overrides } = {}) {
  const reads = [];
  const settingsOpened = [];
  const catalog = { status };
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'skillsStatus') {
        reads.push([request]);
        return { value: catalog.status };
      }
      return request.capability === 'getVoiceStatus' ? { value: { installed: false } } : { value: {} };
    },
    readCapabilities: async (requests) => {
      reads.push(requests);
      return [{ ok: true, value: catalog.status }];
    },
    searchProjectFiles: async () => ['src/app.ts'],
    rendererDiagnostic() {},
  };
  const props = composerProps(id, { onOpenSettings: (section) => settingsOpened.push(section), ...overrides });
  const root = createRoot(document.querySelector('main'));
  t.after(() => act(async () => root.unmount()));
  let input;
  const show = async (next = {}) => {
    await act(async () => root.render(React.createElement(Composer, { ...props, ...next })));
    input = document.querySelector('textarea');
    await act(async () => input.blur());
  };
  await show();
  return {
    reads,
    settingsOpened,
    catalog,
    show,
    get input() {
      return input;
    },
    palette: () => document.getElementById('composer-skill-mention-palette'),
    rows: () =>
      Array.from(
        document
          .getElementById('composer-skill-mention-palette')
          ?.querySelectorAll('[role="option"] .skill-mention-name') || [],
        (node) => node.textContent
      ),
    tokens: () =>
      Array.from(
        document.querySelectorAll('.composer-skill-highlight .skill-mention-token'),
        (node) => node.textContent
      ),
    status: () => document.querySelector('.composer-skill-status')?.textContent || '',
    flush: (ms = 0) => act(async () => new Promise((resolve) => window.setTimeout(resolve, ms))),
    type: (value, caret) => typeInto(input, value, caret),
    key: async (name) => {
      await act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    },
  };
}

const compositionEvent = (view, type) =>
  act(async () => view.input.dispatchEvent(new window.CompositionEvent(type, { bubbles: true })));

test('composer: the $ palette opens mid-sentence, filters, inserts on Tab or click, and Escape dismisses', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-test');
  const { palette, rows, tokens, type, key } = view;
  assert.deepEqual(view.reads[0], [{ capability: 'skillsStatus', sessionId: 'skill-mention-test' }]);

  // `$` mid-sentence lists the custom skills only (pptx is typed, not listed).
  await type('이번 주 커밋 정리해서 $');
  assert.ok(palette(), 'skill palette opens mid-sentence');
  assert.equal(palette().getAttribute('aria-label'), 'Skills');
  assert.equal(palette().querySelector('header').textContent, 'Skills');
  assert.deepEqual(rows(), ['$release-notes', '$api-review']);
  // Same structure as the `@` palette: header and rows, no footer hint.
  assert.equal(palette().querySelector('kbd'), null);
  assert.equal(palette().querySelector('p'), null);
  assert.equal(view.input.getAttribute('aria-controls'), 'composer-skill-mention-palette');
  assert.equal(view.input.getAttribute('aria-expanded'), 'true');
  assert.equal(view.input.getAttribute('aria-activedescendant'), 'composer-skill-mention-option-0');
  await key('ArrowDown');
  assert.equal(view.input.getAttribute('aria-activedescendant'), 'composer-skill-mention-option-1');

  // The query narrows the list and bolds the matched part.
  await type('이번 주 커밋 정리해서 $rel');
  assert.deepEqual(rows(), ['$release-notes']);
  assert.equal(palette().querySelector('[role="option"] b').textContent, 'rel');
  await type('이번 주 커밋 정리해서 $zzz');
  assert.deepEqual(rows(), []);
  assert.equal(palette().querySelector('p[role="status"]').textContent, 'No matching skills.');
  assert.equal(palette().querySelector('.skill-mention-settings'), null);

  // Tab inserts `$name ` over the fragment and keeps the caret after it.
  await type('이번 주 커밋 정리해서 $rel 형식으로', '이번 주 커밋 정리해서 $rel'.length);
  await key('Tab');
  assert.equal(view.input.value, '이번 주 커밋 정리해서 $release-notes 형식으로');
  assert.equal(view.input.selectionStart, '이번 주 커밋 정리해서 $release-notes '.length);
  assert.equal(palette(), null);
  assert.deepEqual(tokens(), ['$release-notes']);
  assert.ok(view.input.classList.contains('has-skill-mentions'));
  assert.equal(document.querySelector('.composer-skill-highlight').textContent.replace('\u200b', ''), view.input.value);

  // Mouse selection inserts the same way; Escape dismisses.
  await type('보고 $');
  await act(async () => palette().querySelectorAll('[role="option"]')[1].click());
  await view.flush();
  assert.equal(view.input.value, '보고 $api-review ');
  await type('보고 $a');
  await key('Escape');
  assert.equal(palette(), null);
  assert.equal(view.input.value, '보고 $a');
});

test('composer: built-ins are highlighted when typed; $HOME, prices and unknown names stay plain', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-plain');
  await view.type('$api-review 기준, $pptx 한 장. $HOME/reports, $300, $unknown-skill도 ');
  assert.deepEqual(view.tokens(), ['$api-review', '$pptx']);
  assert.equal(view.status(), '');
});

test('composer: the @ and $ palettes never open together', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-exclusive');
  await view.type('see @src');
  await view.flush(150);
  assert.ok(document.getElementById('composer-mention-palette'));
  assert.equal(view.palette(), null);
});

test('composer: an existing-but-off skill stays plain and gets the status line', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-off');
  await view.type('$figma-handoff 로 스펙 정리해 줘');
  assert.deepEqual(view.tokens(), []);
  assert.equal(view.input.classList.contains('has-skill-mentions'), false);
  assert.equal(
    view.status(),
    'figma-handoff skill is off, so it is sent as plain text. Turn it on in Settings → Skills.'
  );
  assert.equal(document.querySelector('button.send-button').disabled, false);
});

test('composer: IME composition hands the skill highlight ink back to the textarea', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-ime');
  await view.type('$pptx ');
  assert.ok(view.input.classList.contains('has-skill-mentions'));
  await compositionEvent(view, 'compositionstart');
  assert.equal(view.input.classList.contains('has-skill-mentions'), false);
  assert.equal(document.querySelector('.composer-skill-highlight'), null);
  await compositionEvent(view, 'compositionend');
  assert.ok(view.input.classList.contains('has-skill-mentions'));
});

test('composer: a recognised leading /command takes the accent ink and the mirror text is identical', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-slash');
  const slashTokens = () =>
    Array.from(document.querySelectorAll('.composer-skill-highlight .composer-slash-token'), (n) => n.textContent);
  await view.type('/btw hello');
  assert.deepEqual(slashTokens(), ['/btw']);
  assert.equal(document.querySelector('.composer-skill-highlight').textContent.replace('\u200b', ''), view.input.value);
  await view.type('/bt');
  assert.equal(document.querySelector('.composer-skill-highlight'), null);
  await view.type('/foo x');
  assert.equal(document.querySelector('.composer-skill-highlight'), null);
  await view.type('/btw 안녕');
  await compositionEvent(view, 'compositionstart');
  assert.equal(document.querySelector('.composer-skill-highlight'), null);
  await compositionEvent(view, 'compositionend');
  assert.deepEqual(slashTokens(), ['/btw']);
});

test('composer: with no custom skill on, the palette shows one status line linking to Settings › Skills', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-empty', {
    status: { skills: STATUS.skills.filter((skill) => skill.source === 'builtin') },
  });
  await view.type('$');
  assert.deepEqual(view.rows(), []);
  const line = view.palette().querySelector('p[role="status"]');
  assert.equal(line.textContent, 'No skills are on. Open skill settings');
  await act(async () => line.querySelector('button').click());
  assert.deepEqual(view.settingsOpened, ['skills']);
});

test('composer: a skill toggled elsewhere updates palette, highlight and off notice from change signals, never from typing', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-live');
  const { rows, tokens, status, type, flush } = view;
  await type('$api-review 보고 $');
  assert.deepEqual(rows(), ['$release-notes', '$api-review']);
  assert.deepEqual(tokens(), ['$api-review']);
  const readsBefore = view.reads.length;
  await type('$api-review 보고 $r');
  await type('$api-review 보고 $');
  assert.equal(view.reads.length, readsBefore, 'keystrokes do not re-read skills');
  assert.equal(invalidateSkillCatalogForMutation('setTheme'), false);
  await flush();
  assert.equal(view.reads.length, readsBefore, 'unrelated mutations do not re-read skills');

  const toggled = (name, enabled) => ({
    skills: STATUS.skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
  });
  view.catalog.status = toggled('api-review', false);
  assert.equal(document.activeElement, view.input);
  await act(async () => {
    assert.equal(invalidateSkillCatalogForMutation('setDisabledSkills'), true);
  });
  await flush();
  assert.equal(document.activeElement, view.input);
  assert.deepEqual(rows(), ['$release-notes']);
  assert.deepEqual(tokens(), []);
  assert.equal(status(), 'api-review skill is off, so it is sent as plain text. Turn it on in Settings → Skills.');

  // A setup-tool (or host settings) change brings it back the same way.
  view.catalog.status = STATUS;
  await act(async () =>
    window.dispatchEvent(new window.CustomEvent('mixdog:setup-changed', { detail: { action: 'x' } }))
  );
  await flush();
  assert.deepEqual(rows(), ['$release-notes', '$api-review']);
  assert.deepEqual(tokens(), ['$api-review']);
  assert.equal(status(), '');

  // So does a remote state gap.
  view.catalog.status = toggled('release-notes', false);
  await act(async () => window.dispatchEvent(new window.Event('mixdog:remote-state-gap')));
  await flush();
  assert.deepEqual(rows(), ['$api-review']);
});

test('composer: a skill the session project does not see is neither listed, highlighted nor reported as off', async (t) => {
  const view = await mountSkillComposer(t, 'skill-mention-scoped', { status: SCOPED_STATUS });
  await view.type('$elsewhere $plugin-here $');
  assert.deepEqual(view.rows(), ['$release-notes', '$plugin-here']);
  assert.deepEqual(view.tokens(), ['$plugin-here']);
  assert.equal(view.status(), '');
});

test('composer: a new-task draft reads skills for its selected Project, and re-reads when the Project changes', async (t) => {
  // A draft has no session: it names its Project and the host answers for the folder the task would run in.
  const draft = { sessionId: '', identityScope: 'draft:scoped', projectScope: 'C:/project' };
  const view = await mountSkillComposer(t, 'skill-mention-draft', { status: SCOPED_STATUS, ...draft });
  assert.deepEqual(view.reads[0], [{ capability: 'skillsStatus', args: [{ projectPath: 'C:/project' }] }]);
  await view.type('$elsewhere $plugin-here $');
  assert.deepEqual(view.rows(), ['$release-notes', '$plugin-here']);
  assert.deepEqual(view.tokens(), ['$plugin-here']);
  assert.equal(view.status(), '');

  // A draft with no Project (task workspace) sends no argument.
  const switched = view.reads.length;
  await view.show({ projectScope: 'C:/other' });
  assert.deepEqual(view.reads[switched], [{ capability: 'skillsStatus', args: [{ projectPath: 'C:/other' }] }]);
  const local = view.reads.length;
  await view.show({ projectScope: '' });
  assert.deepEqual(view.reads[local], [{ capability: 'skillsStatus' }]);
});

test('skill catalog reads are single-flight with a minimum age; focus never re-reads, signals force', async () => {
  resetSkillCatalogReadsForTests();
  let count = 0;
  let release;
  window.mixdogDesktop = {
    invokeCapability: async () => {
      count += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return { value: STATUS };
    },
  };
  const first = refreshSkillCatalog('single-flight');
  const second = refreshSkillCatalog('single-flight');
  assert.equal(first, second, 'concurrent reads share one promise');
  assert.equal(count, 1);
  release();
  await first;
  // Within the minimum age the cached catalog is served without a read.
  assert.equal(await refreshSkillCatalog('single-flight'), await first);
  assert.equal(count, 1);
  // A change signal (force) always starts a fresh read.
  const forced = refreshSkillCatalog('single-flight', null, { force: true });
  assert.equal(count, 2);
  release();
  await forced;

  // A mounted catalog no longer re-reads when the window regains focus.
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    useSkillCatalog('focus-probe', '');
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Probe)));
    const mountedReads = count;
    release();
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    assert.equal(count, mountedReads, 'window focus does not read skills');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('@ palette keeps the previous rows while the next query searches, and Enter never inserts them', async () => {
  const pending = new Map();
  window.mixdogDesktop = {
    invokeCapability: async (request) =>
      request.capability === 'getVoiceStatus' ? { value: { installed: false } } : { value: STATUS },
    readCapabilities: async () => [{ ok: true, value: STATUS }],
    searchProjectFiles: (_project, query) => new Promise((resolve) => pending.set(query, resolve)),
    rendererDiagnostic() {},
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const palette = () => document.getElementById('composer-mention-palette');
  const rows = () => Array.from(palette()?.querySelectorAll('[role="option"]') || [], (node) => node.title);
  const settle = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 150)));
  const answer = (query, paths) => act(async () => pending.get(query)(paths));
  let input;
  const type = (value) => typeInto(input, value);
  try {
    await act(async () => root.render(React.createElement(Composer, composerProps('mention-test'))));
    input = host.querySelector('textarea');
    await type('see @a');
    await settle();
    assert.equal(palette().querySelector('p[role="status"]').textContent, 'Searching project files…');
    await answer('a', ['apps/', 'apps/main.ts']);
    assert.deepEqual(rows(), ['apps/', 'apps/main.ts']);

    // The next keystroke searches again; the earlier rows stay on screen.
    await type('see @ap');
    await settle();
    assert.deepEqual(rows(), ['apps/', 'apps/main.ts'], 'no collapse to the status line');
    assert.equal(palette().querySelector('p[role="status"]'), null);
    await act(async () =>
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    );
    assert.equal(input.value, 'see @ap', 'a row of the previous query is never inserted');

    await answer('ap', ['apps/main.ts']);
    assert.deepEqual(rows(), ['apps/main.ts']);
    await act(async () =>
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    );
    assert.equal(input.value, 'see @apps/main.ts ');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
