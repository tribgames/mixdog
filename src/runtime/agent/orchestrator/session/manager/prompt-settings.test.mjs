// The settings notice tells what changed, never what the prompt or an earlier
// notice already holds: one `#` section per item, names and line diffs, capped.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgePendingPromptSettingsNotice,
  DIFF_MAX_BYTES,
  NOTICE_MAX_BYTES,
  promptSettingsNoticeContent,
  promptSettingsRecord,
  rearmPromptSettingsNotice,
  stagePromptSettingsNotice,
} from './prompt-settings.mjs';

const style = (name, body) => `# Output Style: ${name}\n\n${body}`;
const profile = (...lines) => `# Profile Preferences\n\n${lines.join('\n')}`;
const files = (...entries) =>
  ['# Instruction Files', 'intro', ...entries.map(([path, text]) => `## ${path}\n\n${text}`)].join('\n\n');
const bytes = (text) => Buffer.byteLength(text);

const told = (sections) => promptSettingsRecord(sections).texts;

test('a language change is one line', () => {
  const text = promptSettingsNoticeContent(['language'], { language: 'x', responseLanguage: { id: 'ko', name: 'Korean' } });
  assert.match(text, /# Language\nRespond in Korean from now on\.\n/);
});

test('an output style change names the style; its body only when it is small', () => {
  const before = told({ meta: style('Default', 'old') });
  const small = promptSettingsNoticeContent(['meta'], { meta: style('Terse', 'Be brief.') }, before);
  assert.match(small, /# Output Style\nThe output style is now "Terse"\.\n\nBe brief\./);
  const big = promptSettingsNoticeContent(['meta'], { meta: style('Long', 'x'.repeat(2000)) }, before);
  assert.match(big, /The output style is now "Long"\.\nIt applies from the next prompt rebuild\./);
  assert.doesNotMatch(big, /xxxx/);
});

test('a profile change lists the changed fields only, never the whole meta block', () => {
  const before = told({ meta: `${profile('- Title: Boss', '- Level: senior')}\n\n${style('Default', 'Body.')}` });
  const text = promptSettingsNoticeContent(
    ['meta'],
    { meta: `${profile('- Title: Chief', '- Level: senior')}\n\n${style('Default', 'Body.')}` },
    before
  );
  assert.match(text, /# Profile\n- - Title: Boss\n\+ - Title: Chief/);
  assert.doesNotMatch(text, /Level: senior/);
  assert.doesNotMatch(text, /Output Style/);
});

test('core memory is told as an entry diff, capped, with neutral attribution', () => {
  const before = told({ coreMemory: '- a\n- b' });
  const text = promptSettingsNoticeContent(['coreMemory'], { coreMemory: '- a\n- c' }, before);
  assert.match(text, /# Core Memory\nCore memory was updated:\n- - b\n\+ - c/);
  assert.doesNotMatch(text, /- - a|\+ - a/);
  assert.doesNotMatch(text, /user changed/i);
  const many = Array.from({ length: 400 }, (_, i) => `- fact number ${i}`).join('\n');
  const capped = promptSettingsNoticeContent(['coreMemory'], { coreMemory: many }, before);
  const section = capped.split('# Core Memory\n')[1];
  assert.ok(bytes(section) <= DIFF_MAX_BYTES + 200, 'the diff is capped');
  assert.match(section, /more changed lines/);
});

test('instruction files are told as path, line diff and a read pointer, never the whole file', () => {
  const body = Array.from({ length: 50 }, (_, i) => `rule ${i}`).join('\n');
  const before = told({ instructionFiles: files(['/p/AGENTS.md', body]), instructionFilesMode: 'all' });
  const text = promptSettingsNoticeContent(
    ['instructionFiles'],
    { instructionFiles: files(['/p/AGENTS.md', `${body}\nrule new`]), instructionFilesMode: 'all' },
    before
  );
  assert.match(text, /## \/p\/AGENTS\.md\n\+ rule new\nRead \/p\/AGENTS\.md for the full file\./);
  assert.doesNotMatch(text, /rule 7\n/);
  const mode = promptSettingsNoticeContent(
    ['instructionFiles'],
    { instructionFiles: '', instructionFilesMode: 'off' },
    before
  );
  assert.match(mode, /# Instruction Files\nThe instruction files mode is now "off"/);
});

test('a workflow pack change is its name and one line, never the pack body', () => {
  const text = promptSettingsNoticeContent(['workflow'], { workflow: 'SECRET PACK BODY', workflowName: 'Review' });
  assert.match(text, /# Workflow\nThe "Review" workflow pack changed; it applies from the next prompt rebuild\./);
  assert.doesNotMatch(text, /SECRET PACK BODY/);
});

test('a skill listing change names added and removed skills only', () => {
  const manifest = (...names) => ['# available-skills', '<available_skills>', ...names.map((n) => `- ${n}: does ${n}`), '</available_skills>'].join('\n');
  const before = told({ skills: manifest('pdf', 'docx') });
  const text = promptSettingsNoticeContent(['skills'], { skills: manifest('pdf', 'xlsx') }, before);
  assert.match(text, /# Skills\nAdded: xlsx\nRemoved: docx/);
  assert.doesNotMatch(text, /does xlsx/);
  const bodyOnly = promptSettingsNoticeContent(['skills'], { skills: manifest('pdf', 'docx').replace('does pdf', 'new') }, before);
  assert.equal(bodyOnly, '', 'a trigger edit tells nothing');
});

test('the whole notice is capped at 4 KB, every item kept in some form', () => {
  const big = (tag) => Array.from({ length: 60 }, (_, i) => `- ${tag} entry ${i} ${'x'.repeat(20)}`).join('\n');
  const text = promptSettingsNoticeContent(
    ['meta', 'workflow', 'instructionFiles', 'coreMemory', 'language'],
    {
      meta: profile(big('profile')),
      workflowName: 'W',
      instructionFiles: files(['/p/AGENTS.md', big('rule')]),
      coreMemory: big('memory'),
      responseLanguage: { name: 'Korean' },
    },
    { meta: '', instructionFiles: files(['/p/AGENTS.md', 'old']), coreMemory: '' }
  );
  assert.ok(bytes(text) <= NOTICE_MAX_BYTES);
  for (const heading of ['# Profile', '# Workflow', '# Instruction Files', '# Core Memory', '# Language']) {
    assert.ok(text.includes(heading), heading);
  }
});

test('a full block keeps every one-line item and degrades big ones instead of dropping them', () => {
  const big = (tag) => Array.from({ length: 38 }, (_, i) => `${tag} rule ${i} ${'y'.repeat(40)}`).join('\n');
  const before = {
    meta: style('Default', 'old'),
    instructionFiles: files(['/p/AGENTS.md', 'base'], ['/p/CLAUDE.md', 'base']),
    instructionFilesMode: 'all',
    language: 'en',
    responseLanguage: { name: 'English' },
  };
  const after = {
    meta: style('Wordy', 'z'.repeat(1400)),
    instructionFiles: files(['/p/AGENTS.md', `base\n${big('a')}`], ['/p/CLAUDE.md', `base\n${big('c')}`]),
    instructionFilesMode: 'all',
    language: 'ko',
    responseLanguage: { name: 'Korean' },
  };
  const session = { promptSettings: promptSettingsRecord(before) };
  stagePromptSettingsNotice(session, after);
  const { content } = session.promptSettingsNotice;
  assert.ok(bytes(content) <= NOTICE_MAX_BYTES);
  assert.match(content, /Respond in Korean from now on\./, 'the one-line item always fits');
  assert.match(content, /The output style is now "Wordy"/);
  assert.match(content, /\/p\/AGENTS\.md/);
  assert.match(content, /\/p\/CLAUDE\.md/, 'a big item degrades to its path, never dropped');
  assert.doesNotMatch(content, /more changes/);
  acknowledgePendingPromptSettingsNotice(session, session.promptSettingsNotice.revision);
  stagePromptSettingsNotice(session, after);
  assert.equal(session.promptSettingsNotice, undefined, 'everything sent was told: nothing repeats');
});

test('200 instruction files replaced by 200 others drain over several notices, each path named once', () => {
  const set = (tag) =>
    Array.from({ length: 200 }, (_, i) => [`/p/${tag}${i}/AGENTS.md`, `rule ${tag} ${'q'.repeat(30)}`]);
  const before = { instructionFiles: files(...set('old')), instructionFilesMode: 'all', language: 'en' };
  const after = {
    instructionFiles: files(...set('new')),
    instructionFilesMode: 'all',
    language: 'ko',
    responseLanguage: { name: 'Korean' },
  };
  const session = { promptSettings: promptSettingsRecord(before) };
  const added = new Map();
  const gone = new Map();
  let notices = 0;
  for (let turn = 0; turn < 100; turn += 1) {
    stagePromptSettingsNotice(session, after);
    const pending = session.promptSettingsNotice;
    if (!pending) break;
    notices += 1;
    assert.ok(bytes(pending.content) <= NOTICE_MAX_BYTES);
    assert.doesNotMatch(pending.content, /instruction files changed; read them/, 'never a bare count');
    for (const [, path] of pending.content.matchAll(/^- added: (\S+)/gm)) added.set(path, (added.get(path) || 0) + 1);
    for (const [, path] of pending.content.matchAll(/^- no longer applies: (\S+)/gm)) {
      gone.set(path, (gone.get(path) || 0) + 1);
    }
    assert.ok(acknowledgePendingPromptSettingsNotice(session, pending.revision));
  }
  assert.ok(notices > 1, 'a large batch takes several notices');
  assert.equal(session.promptSettingsNotice, undefined, 'it drains');
  assert.equal(added.size, 200);
  assert.equal(gone.size, 200);
  assert.ok([...added.values(), ...gone.values()].every((count) => count === 1), 'each path named once');
});

test("a worker's first notice stripped by a mid-turn compaction is told again, compact", () => {
  const english = { language: 'en block', responseLanguage: { name: 'English' }, coreMemory: '- a' };
  const korean = { language: 'ko block', responseLanguage: { name: 'Korean' }, coreMemory: '- a\n- b' };
  const worker = { owner: 'agent', promptIdentity: { agent: 'worker' }, promptSettings: promptSettingsRecord(english) };
  stagePromptSettingsNotice(worker, korean);
  const inFlight = worker.promptSettingsNotice.revision; // the running turn carries it
  assert.equal(rearmPromptSettingsNotice(worker), true, 'the compaction removed it');
  assert.equal(acknowledgePendingPromptSettingsNotice(worker, inFlight), false, 'settlement acknowledges nothing');
  stagePromptSettingsNotice(worker, korean);
  const again = worker.promptSettingsNotice.content;
  assert.match(again, /Respond in Korean/);
  assert.match(again, /Core memory was updated; it applies from the next prompt rebuild\./, 'compact form');
  assert.doesNotMatch(again, /\+ - b/);
});

test('moving a setting back after its notice was told tells the revert', () => {
  const english = { language: 'en block', responseLanguage: { name: 'English' } };
  const korean = { language: 'ko block', responseLanguage: { name: 'Korean' } };
  const session = { promptSettings: promptSettingsRecord(english) };
  assert.deepEqual(stagePromptSettingsNotice(session, korean), ['language']);
  assert.ok(acknowledgePendingPromptSettingsNotice(session, session.promptSettingsNotice.revision));
  assert.deepEqual(stagePromptSettingsNotice(session, english), []);
  assert.match(session.promptSettingsNotice.content, /Respond in English from now on/);
  assert.ok(acknowledgePendingPromptSettingsNotice(session, session.promptSettingsNotice.revision));
  stagePromptSettingsNotice(session, english);
  assert.equal(session.promptSettingsNotice, undefined, 'told once');
});

test('a compaction re-tells a worker what it was told; a Lead folds instead', () => {
  const english = { language: 'en block', responseLanguage: { name: 'English' } };
  const korean = { language: 'ko block', responseLanguage: { name: 'Korean' } };
  const worker = { owner: 'agent', promptIdentity: { agent: 'worker' }, promptSettings: promptSettingsRecord(english) };
  stagePromptSettingsNotice(worker, korean);
  acknowledgePendingPromptSettingsNotice(worker, worker.promptSettingsNotice.revision);
  assert.equal(rearmPromptSettingsNotice(worker), true);
  stagePromptSettingsNotice(worker, korean);
  assert.match(worker.promptSettingsNotice.content, /Respond in Korean/);
  const lead = { owner: 'user', promptIdentity: { agent: 'lead' }, promptSettings: promptSettingsRecord(english) };
  stagePromptSettingsNotice(lead, korean);
  acknowledgePendingPromptSettingsNotice(lead, lead.promptSettingsNotice.revision);
  assert.equal(rearmPromptSettingsNotice(lead), false);
});
