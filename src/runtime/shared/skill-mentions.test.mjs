import assert from 'node:assert/strict';
import test from 'node:test';
import { mentionedSkillNames, skillMentionCandidates, skillMentions } from './skill-mentions.mjs';

const known = new Set(['api-review', 'pptx', 'release-notes']);
const isSkill = (name) => known.has(name);

test('a $name anywhere in the text selects a known skill, with its exact span', () => {
  const text = '이번 주 커밋 정리해서 $release-notes 형식으로';
  const [mention] = skillMentions(text, isSkill);
  assert.equal(mention.name, 'release-notes');
  assert.equal(text.slice(mention.start, mention.end), '$release-notes');
});

test('unknown names, env vars, prices and mid-word dollars stay prose', () => {
  const text = '$api-review then $pptx. Path $HOME/x, budget $300, $unknown-skill, a$pptx, US$pptx';
  assert.deepEqual(
    skillMentions(text, isSkill).map((mention) => mention.name),
    ['api-review', 'pptx']
  );
  assert.deepEqual(
    skillMentionCandidates('$HOME $Path $300').map((mention) => mention.name),
    ['300']
  );
});

test('a mention may follow an opening bracket or quote and end at punctuation', () => {
  assert.deepEqual(mentionedSkillNames('("$pptx"), [$api-review]: done', isSkill), ['pptx', 'api-review']);
});

test('a name longer than a skill name can be is not a mention', () => {
  assert.deepEqual(skillMentionCandidates(`$${'a'.repeat(65)}`), []);
  assert.equal(skillMentionCandidates(`$${'a'.repeat(64)}`).length, 1);
});

test('repeated mentions are kept per occurrence and deduplicated by name', () => {
  const text = '$pptx and again $pptx with $api-review';
  assert.equal(skillMentions(text, isSkill).length, 3);
  assert.deepEqual(mentionedSkillNames(text, isSkill), ['pptx', 'api-review']);
});
