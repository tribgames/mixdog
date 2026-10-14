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

const palette = (promptDraft, extra = {}) => deriveSlashPalette({ promptDraft, slashDismissedFor: '', skills: SKILLS, ...extra });

test('a $ mention is the token being typed at the end of the draft, after a boundary', () => {
  assert.deepEqual(skillMentionQuery('$'), { query: '', start: 0 });
  assert.deepEqual(skillMentionQuery('use $pd'), { query: 'pd', start: 4 });
  assert.deepEqual(skillMentionQuery('see ("$dep'), { query: 'dep', start: 6 });
  for (const draft of ['', 'plain', 'a$pd', 'me@$pd', '$pd ', '$Pd', '$-x', 'cost $5 now']) {
    assert.equal(skillMentionQuery(draft), null, draft);
  }
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

test('completion replaces only the mention with `$name `', () => {
  assert.equal(completeSkillMention('please use $pd', 'pdf-tools'), 'please use $pdf-tools ');
  assert.equal(completeSkillMention('$', 'deploy'), '$deploy ');
  assert.equal(completeSkillMention('no mention', 'deploy'), undefined);
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
