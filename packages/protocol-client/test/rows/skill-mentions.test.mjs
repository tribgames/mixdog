import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isInMarkdownCode,
  isReservedMentionName,
  mentionedSkillNames,
  skillMentionCandidates,
  skillMentions,
} from './skill-mentions.mjs';

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
    []
  );
});

test('a token continued by any ASCII identifier character is not the shorter name', () => {
  for (const text of ['$pptx_env', '$pptxUPPER', '$pptx-', '$pptx2', '$pptxA b']) {
    assert.deepEqual(mentionedSkillNames(text, isSkill), [], text);
  }
  for (const text of ['$pptx로 만들어', '$pptx.', '$pptx, ok', '($pptx)', '$pptx\n', '$pptx—done']) {
    assert.deepEqual(mentionedSkillNames(text, isSkill), ['pptx'], text);
  }
  const text = '결과는 $pptx로';
  const [mention] = skillMentions(text, isSkill);
  assert.equal(text.slice(mention.start, mention.end), '$pptx');
});

test('$name inside Markdown code is not a mention; offsets stay those of the original text', () => {
  const none = [
    '`$pptx`',
    'run `echo $pptx` now',
    '```\n$pptx\n```',
    '```js title="x"\nconst a = "$pptx";\n```',
    '~~~\n$pptx\n~~~',
    '~~~~\n$pptx\n~~~\n$pptx\n~~~~',
    '````\n$pptx\n```\nstill code $pptx',
    '```\nunclosed fence $pptx',
    '`` a ` $pptx ``',
    '```\r\n$pptx\r\n```',
  ];
  for (const text of none) assert.deepEqual(skillMentions(text, isSkill), [], JSON.stringify(text));

  const after = (text, expectedStart) => {
    const mentions = skillMentions(text, isSkill);
    assert.equal(mentions.length, 1, JSON.stringify(text));
    assert.equal(mentions[0].start, expectedStart, JSON.stringify(text));
    assert.equal(text.slice(mentions[0].start, mentions[0].end), '$pptx');
  };
  after('`$api` then $pptx', '`$api` then '.length);
  after('```\n$pptx\n```\nnow $pptx', '```\n$pptx\n```\nnow '.length);
  after('~~~\n$pptx\n~~~\n$pptx', '~~~\n$pptx\n~~~\n'.length);
  after('```\r\n$pptx\r\n```\r\nuse $pptx\r\n', '```\r\n$pptx\r\n```\r\nuse '.length);
  // An unmatched backtick run is literal text.
  after('a ` lone tick $pptx', 'a ` lone tick '.length);
  after('`` x ` y $pptx', '`` x ` y '.length);
  // A double-backtick span may contain single backticks; text after it counts.
  after('`` a ` b `` and $pptx', '`` a ` b `` and '.length);
  // A ``` run inside a line is an inline span, not a fence.
  after('see ```$api``` and $pptx', 'see ```$api``` and '.length);
});

test('isInMarkdownCode agrees with mention recognition at every offset', () => {
  const texts = [
    'a `$pptx` b $pptx',
    '```\n$pptx\n```\n$pptx',
    '~~~~\n$pptx\n~~~\nx $pptx\n~~~~ $pptx',
    '`` a ` $pptx `` $pptx',
    'lone ` $pptx',
    '```\r\n$pptx\r\n```\r\n$pptx',
    'no code $pptx',
  ];
  for (const text of texts) {
    const outside = new Set(skillMentions(text, isSkill).map((mention) => mention.start));
    for (let index = text.indexOf('$'); index >= 0; index = text.indexOf('$', index + 1)) {
      assert.equal(isInMarkdownCode(text, index), !outside.has(index), `${JSON.stringify(text)} @${index}`);
    }
  }
  assert.equal(isInMarkdownCode('`x`', 1), true);
  assert.equal(isInMarkdownCode('`x`', 3), false);
  assert.equal(isInMarkdownCode('plain', 0), false);
  assert.equal(isInMarkdownCode(null, 0), false);
});

test('environment-variable names and numbers are never mentions, even as skill names', () => {
  const reserved = [
    'path',
    'home',
    'user',
    'shell',
    'pwd',
    'tmpdir',
    'temp',
    'tmp',
    'lang',
    'term',
    'userprofile',
    'appdata',
    'localappdata',
    'programfiles',
    'systemroot',
    'windir',
    'comspec',
    '300',
    '2024',
  ];
  const everything = () => true;
  for (const name of reserved) {
    assert.equal(isReservedMentionName(name), true, name);
    assert.equal(isReservedMentionName(name.toUpperCase()), true, name);
    assert.deepEqual(skillMentionCandidates(`use $${name} here`), [], name);
    assert.deepEqual(mentionedSkillNames(`use $${name}`, everything), [], name);
  }
  assert.equal(isReservedMentionName('XDG_CONFIG_HOME'), true);
  for (const name of ['pptx', 'path-tools', 'home2', '3d', 'temp-notes']) {
    assert.equal(isReservedMentionName(name), false, name);
    assert.deepEqual(mentionedSkillNames(`$${name}`, everything), [name], name);
  }
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
