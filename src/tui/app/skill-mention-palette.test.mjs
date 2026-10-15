import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSkillMention, skillMentionItems, skillMentionQuery } from './skill-mention-palette.mjs';
import { deriveSlashPalette } from './slash-palette.mjs';

const SKILLS = [
  { name: 'pdf-tools', description: 'PDF work', source: 'global', enabled: true },
  { name: 'deploy', description: 'Ship it', source: 'global', enabled: true },
  { name: 'report-pdf', description: 'Reports', source: 'plugin', enabled: true },
  { name: 'pdf-off', description: 'Disabled', source: 'global', enabled: false },
  { name: 'pdf', description: 'Built-in', source: 'builtin', enabled: true },
];

const palette = (promptDraft, extra = {}) =>
  deriveSlashPalette({ promptDraft, slashDismissedFor: '', skills: SKILLS, ...extra });

test('a $ mention is the token being typed before the caret (default: end), after a boundary', () => {
  assert.deepEqual(skillMentionQuery('$'), { query: '', start: 0, end: 1 });
  assert.deepEqual(skillMentionQuery('use $pd'), { query: 'pd', start: 4, end: 7 });
  assert.deepEqual(skillMentionQuery('see ("$dep'), { query: 'dep', start: 6, end: 10 });
  for (const draft of ['', 'plain', 'a$pd', 'me@$pd', '$pd ', '$Pd', '$-x', 'cost $5 now']) {
    assert.equal(skillMentionQuery(draft), null, draft);
  }
});

test('the mention follows the caret mid-text and across lines', () => {
  const draft = 'fix $pd then ship';
  assert.deepEqual(skillMentionQuery(draft, 7), { query: 'pd', start: 4, end: 7 });
  assert.deepEqual(skillMentionQuery(draft, 5), { query: '', start: 4, end: 5 });
  assert.deepEqual(skillMentionQuery(draft, 6), { query: 'p', start: 4, end: 6 });
  assert.equal(skillMentionQuery(draft, 4), null, 'caret before the $');
  assert.equal(skillMentionQuery(draft), null, 'caret at the end, after prose');
  const lines = 'first line\n$dep\nlast line';
  assert.deepEqual(skillMentionQuery(lines, 15), { query: 'dep', start: 11, end: 15 });
  assert.equal(skillMentionQuery(lines, 10), null);
  assert.equal(skillMentionQuery('echo $HOME and more', 10), null);
  assert.equal(skillMentionQuery('pay $300 today', 8)?.query, '300', 'parser-shaped, but no skill matches');
});

test('rows list enabled custom skills, prefix matches before contains matches', () => {
  assert.deepEqual(
    skillMentionItems(SKILLS, 'pdf').map((item) => item.label),
    ['$pdf-tools', '$report-pdf']
  );
  assert.deepEqual(
    skillMentionItems(SKILLS, '').map((item) => item.name),
    ['deploy', 'pdf-tools', 'report-pdf']
  );
  assert.deepEqual(skillMentionItems(SKILLS, 'zzz'), []);
  assert.equal(skillMentionItems(SKILLS, 'dep')[0].description, 'Ship it');
});

test('rows drop skills outside this project and reserved (env-var/number) names', () => {
  const skills = [
    ...SKILLS,
    { name: 'pdf-elsewhere', source: 'global', enabled: true, activeHere: false },
    { name: 'pdf-here', source: 'plugin', enabled: true, activeHere: true },
    { name: 'path', source: 'global', enabled: true },
    { name: '300', source: 'global', enabled: true },
  ];
  assert.deepEqual(
    skillMentionItems(skills, 'pdf').map((item) => item.name),
    ['pdf-here', 'pdf-tools', 'report-pdf']
  );
  assert.deepEqual(skillMentionItems(skills, 'pa'), []);
  assert.deepEqual(skillMentionItems(skills, '3'), []);
});

test('completion replaces only the `$fragment` before the caret with `$name `', () => {
  assert.deepEqual(completeSkillMention('please use $pd', 'pdf-tools'), {
    value: 'please use $pdf-tools ',
    cursor: 22,
  });
  assert.deepEqual(completeSkillMention('$', 'deploy'), { value: '$deploy ', cursor: 8 });
  assert.equal(completeSkillMention('no mention', 'deploy'), undefined);
  // Mid-text: the suffix after the caret is kept; the caret lands after `$name `.
  assert.deepEqual(completeSkillMention('fix $pd then ship', 'pdf-tools', 7), {
    value: 'fix $pdf-tools  then ship',
    cursor: 15,
  });
  assert.deepEqual(completeSkillMention('fix $pdzz', 'pdf-tools', 7), { value: 'fix $pdf-tools zz', cursor: 15 });
  assert.deepEqual(completeSkillMention('a\n$de\nb', 'deploy', 5), { value: 'a\n$deploy \nb', cursor: 10 });
  assert.equal(completeSkillMention('fix $pd then ship', 'pdf-tools', 3), undefined);
});

test('the palette opens in skill mode only while a skill matches; slash commands keep precedence', () => {
  const open = palette('fix it with $pd');
  assert.equal(open.paletteKind, 'skills');
  assert.equal(open.slashPaletteOpen, true);
  assert.equal(open.activeSlashQuery, 'pd');
  assert.deepEqual(
    open.slashCommands.map((item) => item.name),
    ['pdf-tools', 'report-pdf']
  );
  for (const draft of ['echo $HOME', 'pay $300', 'try $zzz']) {
    assert.equal(palette(draft).slashPaletteOpen, false, draft);
  }
  assert.equal(palette('fix it with $pd', { slashDismissedFor: 'fix it with $pd' }).slashPaletteOpen, false);
  assert.equal(palette('fix it with $pd', { picker: {} }).slashPaletteOpen, false);
  const slash = palette('/sk');
  assert.equal(slash.paletteKind, 'commands');
  assert.deepEqual(
    slash.slashCommands.map((command) => command.name),
    ['skills']
  );
  assert.equal(palette('plain text').slashPaletteOpen, false);
});

test('the skill palette stays closed while the caret is inside inline code or a fenced block', () => {
  const at = (draft, marker = '|') => {
    const caret = draft.indexOf(marker);
    return palette(draft.replace(marker, ''), { promptCaret: caret });
  };
  for (const draft of [
    'run `echo $pd|` here',
    '`$pd|`',
    '`` a ` $pd| ``',
    '```\n$pd|\n```',
    '```sh\nfoo $pd|',
    '~~~\nuse $pd|\n~~~ after',
    '```\r\n$pd|\r\n```',
  ]) {
    assert.equal(at(draft).slashPaletteOpen, false, JSON.stringify(draft));
    assert.equal(skillMentionQuery(draft.replace('|', ''), draft.indexOf('|')), null, JSON.stringify(draft));
  }
  for (const draft of [
    '`code` then $pd|',
    '```\nx\n```\nnow $pd|',
    'a lone ` tick $pd|',
    '`` x ` y $pd|',
    '~~~\nx\n~~~\n$pd| more',
  ]) {
    const shown = at(draft);
    assert.equal(shown.slashPaletteOpen, true, JSON.stringify(draft));
    assert.equal(shown.paletteKind, 'skills');
  }
});

test('the skill palette opens and filters at a mid-text caret, multi-line included', () => {
  const draft = 'fix $pd then ship';
  const mid = palette(draft, { promptCaret: 7 });
  assert.equal(mid.paletteKind, 'skills');
  assert.equal(mid.slashPaletteOpen, true);
  assert.deepEqual(
    mid.slashCommands.map((item) => item.name),
    ['pdf-tools', 'report-pdf']
  );
  assert.deepEqual(
    palette(draft, { promptCaret: 5 }).slashCommands.map((item) => item.name),
    ['deploy', 'pdf-tools', 'report-pdf']
  );
  assert.equal(palette(draft).slashPaletteOpen, false, 'caret at the end, after prose');
  assert.equal(palette(draft, { promptCaret: 4 }).slashPaletteOpen, false, 'caret before the $');
  assert.equal(palette('echo $HOME and more', { promptCaret: 10 }).slashPaletteOpen, false);
  assert.equal(palette('pay $300 today', { promptCaret: 8 }).slashPaletteOpen, false);
  const lines = palette('first\n$rep\nlast', { promptCaret: 10 });
  assert.equal(lines.slashPaletteOpen, true);
  assert.deepEqual(
    lines.slashCommands.map((item) => item.name),
    ['report-pdf']
  );
  // Esc dismisses for this exact draft wherever the caret is.
  assert.equal(palette(draft, { promptCaret: 7, slashDismissedFor: draft }).slashPaletteOpen, false);
  // The slash palette ignores the caret.
  assert.deepEqual(
    palette('/sk', { promptCaret: 1 }).slashCommands.map((command) => command.name),
    ['skills']
  );
});
