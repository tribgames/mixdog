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

test('composer: $ palette opens, filters, inserts; tokens highlight; off skills get a status line', async () => {
  const reads = [];
  const settingsOpened = [];
  let currentStatus = STATUS;
  window.mixdogDesktop = {
    // A session's skills are read from that session (its cwd decides scope);
    // a draft's from the control session.
    invokeCapability: async (request) => {
      if (request.capability === 'skillsStatus') {
        reads.push([request]);
        return { value: currentStatus };
      }
      return request.capability === 'getVoiceStatus' ? { value: { installed: false } } : { value: {} };
    },
    readCapabilities: async (requests) => {
      reads.push(requests);
      return [{ ok: true, value: currentStatus }];
    },
    searchProjectFiles: async () => ['src/app.ts'],
    rendererDiagnostic() {},
  };
  const props = {
    turnBusy: false,
    commandBusy: false,
    transitioning: false,
    focusRequest: 0,
    historyScope: 'skill-mention-test',
    identityScope: 'skill-mention-test',
    recoveryScope: 'skill-mention-test',
    projectScope: 'C:/project',
    sessionId: 'skill-mention-test',
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
    onOpenSettings: (section) => settingsOpened.push(section),
    onOpenCommandSurface() {},
    dropTargetRef: { current: null },
  };
  const host = document.querySelector('main');
  const root = createRoot(host);
  const palette = () => document.getElementById('composer-skill-mention-palette');
  const rows = () =>
    Array.from(palette()?.querySelectorAll('[role="option"] .skill-mention-name') || [], (node) => node.textContent);
  const tokens = () =>
    Array.from(document.querySelectorAll('.composer-skill-highlight .skill-mention-token'), (node) => node.textContent);
  const status = () => document.querySelector('.composer-skill-status')?.textContent || '';
  let input;
  const type = async (value, caret = value.length) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const key = async (name) => {
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () => root.render(React.createElement(Composer, props)));
    input = document.querySelector('textarea');
    assert.deepEqual(reads[0], [{ capability: 'skillsStatus', sessionId: 'skill-mention-test' }]);

    // A: mid-sentence `$` lists the custom skills only (pptx is typed, not listed).
    await type('이번 주 커밋 정리해서 $');
    assert.ok(palette(), 'skill palette opens mid-sentence');
    assert.equal(palette().getAttribute('aria-label'), 'Skills');
    assert.equal(palette().querySelector('header').textContent, 'Skills');
    assert.deepEqual(rows(), ['$release-notes', '$api-review']);
    // Same structure as the `@` palette: header and rows, no footer hint.
    assert.equal(palette().querySelector('kbd'), null);
    assert.equal(palette().querySelector('p'), null);
    assert.equal(input.getAttribute('aria-controls'), 'composer-skill-mention-palette');
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(input.getAttribute('aria-activedescendant'), 'composer-skill-mention-option-0');
    await key('ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'), 'composer-skill-mention-option-1');

    // B: the query narrows the list and bolds the matched part.
    await type('이번 주 커밋 정리해서 $rel');
    assert.deepEqual(rows(), ['$release-notes']);
    assert.equal(palette().querySelector('[role="option"] b').textContent, 'rel');
    await type('이번 주 커밋 정리해서 $zzz');
    assert.deepEqual(rows(), []);
    assert.equal(palette().querySelector('p[role="status"]').textContent, 'No matching skills.');
    assert.equal(palette().querySelector('.skill-mention-settings'), null);

    // C: Tab inserts `$name ` over the fragment and keeps the caret after it.
    await type('이번 주 커밋 정리해서 $rel 형식으로', '이번 주 커밋 정리해서 $rel'.length);
    await key('Tab');
    assert.equal(input.value, '이번 주 커밋 정리해서 $release-notes 형식으로');
    assert.equal(input.selectionStart, '이번 주 커밋 정리해서 $release-notes '.length);
    assert.equal(palette(), null);
    assert.deepEqual(tokens(), ['$release-notes']);
    assert.ok(input.classList.contains('has-skill-mentions'));
    assert.equal(document.querySelector('.composer-skill-highlight').textContent.replace('\u200b', ''), input.value);

    // Mouse selection inserts the same way; Escape dismisses.
    await type('보고 $');
    await act(async () => palette().querySelectorAll('[role="option"]')[1].click());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    assert.equal(input.value, '보고 $api-review ');
    await type('보고 $a');
    await key('Escape');
    assert.equal(palette(), null);
    assert.equal(input.value, '보고 $a');

    // D: built-ins are recognised when typed; $HOME, prices and unknown names stay plain.
    await type('$api-review 기준, $pptx 한 장. $HOME/reports, $300, $unknown-skill도 ');
    assert.deepEqual(tokens(), ['$api-review', '$pptx']);
    assert.equal(status(), '');

    // `@` and `$` never open together.
    await type('see @src');
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 150)));
    assert.ok(document.getElementById('composer-mention-palette'));
    assert.equal(palette(), null);

    // F: an existing-but-off skill stays plain and gets the status line.
    await type('$figma-handoff 로 스펙 정리해 줘');
    assert.deepEqual(tokens(), []);
    assert.equal(input.classList.contains('has-skill-mentions'), false);
    assert.equal(status(), 'figma-handoff skill is off, so it is sent as plain text. Turn it on in Settings › Skills.');
    assert.equal(document.querySelector('button.send-button').disabled, false);

    // IME composition hands the ink back to the textarea.
    await type('$pptx ');
    assert.ok(input.classList.contains('has-skill-mentions'));
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    assert.equal(input.classList.contains('has-skill-mentions'), false);
    assert.equal(document.querySelector('.composer-skill-highlight'), null);
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    assert.ok(input.classList.contains('has-skill-mentions'));

    // A recognised leading /command takes the accent ink; the mirror text is identical.
    const slashTokens = () =>
      Array.from(document.querySelectorAll('.composer-skill-highlight .composer-slash-token'), (n) => n.textContent);
    await type('/btw hello');
    assert.deepEqual(slashTokens(), ['/btw']);
    assert.equal(document.querySelector('.composer-skill-highlight').textContent.replace('\u200b', ''), input.value);
    await type('/bt');
    assert.equal(document.querySelector('.composer-skill-highlight'), null);
    await type('/foo x');
    assert.equal(document.querySelector('.composer-skill-highlight'), null);
    await type('/btw 안녕');
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    assert.equal(document.querySelector('.composer-skill-highlight'), null);
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    assert.deepEqual(slashTokens(), ['/btw']);

    // No custom skill on: one status line with an inline link to Settings › Skills.
    currentStatus = { skills: STATUS.skills.filter((skill) => skill.source === 'builtin') };
    const empty = { ...props, sessionId: 'skill-mention-empty', identityScope: 'skill-mention-empty' };
    await act(async () => root.render(React.createElement(Composer, empty)));
    input = document.querySelector('textarea');
    // The identity switch drops the focus flag; focus the field afresh.
    await act(async () => input.blur());
    await type('$');
    assert.deepEqual(rows(), []);
    const line = palette().querySelector('p[role="status"]');
    assert.equal(line.textContent, 'No skills are on. Open skill settings');
    await act(async () => line.querySelector('button').click());
    assert.deepEqual(settingsOpened, ['skills']);

    // A skill toggled elsewhere while the composer keeps focus: the palette,
    // highlight and off-skill notice follow the app's change signals, and
    // typing alone never re-reads the catalog.
    currentStatus = STATUS;
    const live = { ...props, sessionId: 'skill-mention-live', identityScope: 'skill-mention-live' };
    await act(async () => root.render(React.createElement(Composer, live)));
    input = document.querySelector('textarea');
    await act(async () => input.blur());
    await type('$api-review 보고 $');
    assert.deepEqual(rows(), ['$release-notes', '$api-review']);
    assert.deepEqual(tokens(), ['$api-review']);
    const settle = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    const readsBefore = reads.length;
    await type('$api-review 보고 $r');
    await type('$api-review 보고 $');
    assert.equal(reads.length, readsBefore, 'keystrokes do not re-read skills');
    assert.equal(invalidateSkillCatalogForMutation('setTheme'), false);
    await settle();
    assert.equal(reads.length, readsBefore, 'unrelated mutations do not re-read skills');

    const toggled = (name, enabled) => ({
      skills: STATUS.skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
    });
    currentStatus = toggled('api-review', false);
    assert.equal(document.activeElement, input);
    await act(async () => {
      assert.equal(invalidateSkillCatalogForMutation('setDisabledSkills'), true);
    });
    await settle();
    assert.equal(document.activeElement, input);
    assert.deepEqual(rows(), ['$release-notes']);
    assert.deepEqual(tokens(), []);
    assert.equal(status(), 'api-review skill is off, so it is sent as plain text. Turn it on in Settings › Skills.');

    // A setup-tool (or host settings) change brings it back the same way.
    currentStatus = STATUS;
    await act(async () =>
      window.dispatchEvent(new window.CustomEvent('mixdog:setup-changed', { detail: { action: 'x' } }))
    );
    await settle();
    assert.deepEqual(rows(), ['$release-notes', '$api-review']);
    assert.deepEqual(tokens(), ['$api-review']);
    assert.equal(status(), '');

    // So does a remote state gap.
    currentStatus = toggled('release-notes', false);
    await act(async () => window.dispatchEvent(new window.Event('mixdog:remote-state-gap')));
    await settle();
    assert.deepEqual(rows(), ['$api-review']);

    // Scope: a skill the session's project does not see is neither listed,
    // highlighted nor reported as off; one it sees (here via its plugin) is.
    currentStatus = SCOPED_STATUS;
    const scoped = { ...props, sessionId: 'skill-mention-scoped', identityScope: 'skill-mention-scoped' };
    await act(async () => root.render(React.createElement(Composer, scoped)));
    input = document.querySelector('textarea');
    await act(async () => input.blur());
    await type('$elsewhere $plugin-here $');
    assert.deepEqual(rows(), ['$release-notes', '$plugin-here']);
    assert.deepEqual(tokens(), ['$plugin-here']);
    assert.equal(status(), '');

    // A new-task draft has no session yet: it names its selected Project and
    // the host answers for the folder that task would run in.
    const draftReads = reads.length;
    const draft = { ...props, sessionId: '', identityScope: 'draft:scoped', projectScope: 'C:/project' };
    await act(async () => root.render(React.createElement(Composer, draft)));
    input = document.querySelector('textarea');
    await act(async () => input.blur());
    assert.deepEqual(reads[draftReads], [{ capability: 'skillsStatus', args: [{ projectPath: 'C:/project' }] }]);
    await type('$elsewhere $plugin-here $');
    assert.deepEqual(rows(), ['$release-notes', '$plugin-here']);
    assert.deepEqual(tokens(), ['$plugin-here']);
    assert.equal(status(), '');

    // Switching the draft's Project re-reads for the new one; a draft with no
    // Project (task workspace) sends no argument.
    const switched = reads.length;
    await act(async () => root.render(React.createElement(Composer, { ...draft, projectScope: 'C:/other' })));
    assert.deepEqual(reads[switched], [{ capability: 'skillsStatus', args: [{ projectPath: 'C:/other' }] }]);
    const local = reads.length;
    await act(async () => root.render(React.createElement(Composer, { ...draft, projectScope: '' })));
    assert.deepEqual(reads[local], [{ capability: 'skillsStatus' }]);
  } finally {
    await act(async () => root.unmount());
  }
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
  const type = async (value) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(Composer, {
          turnBusy: false,
          commandBusy: false,
          transitioning: false,
          focusRequest: 0,
          historyScope: 'mention-test',
          identityScope: 'mention-test',
          recoveryScope: 'mention-test',
          projectScope: 'C:/project',
          sessionId: 'mention-test',
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
        })
      )
    );
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
