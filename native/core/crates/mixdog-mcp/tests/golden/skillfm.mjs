// Records, from today's Node product, what createSkillDocument and updateSkillDocument write for a
// skill's name, description and trigger over frontmatter written in many styles: the old value's
// scalar style (plain, quoted, block, multi-line, with a trailing comment), the new value's
// shape (quoting needs, folding at 80 columns, multi-line, control characters), extra keys and
// comments, CRLF and a byte-order mark, and missing keys.
// `stable` says whether Node writes the frontmatter back unchanged when nothing is edited; where
// it does not, Node has also normalized text the edit never touches.
// Usage: node skillfm.mjs <repo-root> <out.json>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [root, out] = process.argv.slice(2);
const doc = await import(pathToFileURL(join(root, 'src', 'runtime', 'shared', 'skill-document.mjs')).href);
const { parseDocument } = createRequire(join(root, 'package.json'))('yaml');

const FRONT_RE = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const stableFront = (markdown) => {
  const front = markdown.match(FRONT_RE)[1];
  return `${String(parseDocument(front, { strict: true, uniqueKeys: true })).trimEnd()}` === front.replace(/\r\n/g, '\n').trimEnd();
};

const BODY = 'Body text';
const long = (n, word = 'alpha') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const values = [
  'Short text',
  'Use when asked: do it',
  'Has a # hash inside',
  'Trailing hash #',
  '- dash start',
  '-',
  '? question',
  '*star',
  '&amp',
  '!bang',
  '|pipe',
  '>gt',
  '%percent',
  '@at',
  '`tick',
  '[bracket] start',
  '{brace} start',
  'a, b, c',
  '"double" quoted',
  "it's single",
  `both "double" and 'single'`,
  'true',
  'null',
  '~',
  '123',
  '1.5',
  '0x1F',
  '1e3',
  '.inf',
  'Yes',
  'ends with colon:',
  'colon: inside',
  'colon:nospace',
  'tab\tinside',
  'line one\nline two',
  'line one\n\nline three',
  'line one\n  indented two\nline three',
  'line one\n\n\nline four',
  'a\nb\nc\nd\ne',
  `${long(30)}\nsecond short line`,
  'x\ty\nz',
  '한국어 설명입니다 사용할 때',
  `${long(14, '한글')}`,
  `emoji ${'😀 '.repeat(40)}end`,
  long(14),
  long(40),
  long(120),
  'x'.repeat(100),
  `${'y'.repeat(70)} ${'z'.repeat(70)}`,
  `short\n${long(60)}`,
  'with \u0001 control',
  'with \r carriage',
  'with \u2028 separator',
  'with \u0085 nel',
  'with \u00a0 nbsp',
  'trailing\\backslash and "quote" and \\n literal',
  '---',
  'first\n---\nthird',
  '...dots',
  '--- not a marker at start',
  'line\n# not a comment',
  'a: b\nc: d',
  'multi\nline with "quotes" and \'single\'',
  `${long(25)} "double" ${long(25)}`,
  `${long(25)} it's ${long(25)}`,
];

const olds = {
  plain: { name: 'name: my-skill', description: 'description: Old desc', when: 'when_to_use: Old when' },
  dq: { name: 'name: "my-skill"', description: 'description: "Old desc"', when: 'when_to_use: "Old when"' },
  sq: { name: "name: 'my-skill'", description: "description: 'Old desc'", when: "when_to_use: 'Old when'" },
  literal: { name: 'name: my-skill', description: 'description: |\n  Old desc', when: 'when_to_use: |\n  Old when' },
  literalStrip: { name: 'name: my-skill', description: 'description: |-\n  Old desc', when: 'when_to_use: |-\n  Old when' },
  literalKeep: { name: 'name: my-skill', description: 'description: |+\n  Old desc\n', when: 'when_to_use: |+\n  Old when\n' },
  folded: { name: 'name: my-skill', description: 'description: >\n  Old desc', when: 'when_to_use: >\n  Old when' },
  foldedStrip: { name: 'name: my-skill', description: 'description: >-\n  Old desc\n  more', when: 'when_to_use: >-\n  Old when' },
  plainMulti: { name: 'name: my-skill', description: 'description: Old desc\n  continued here', when: 'when_to_use: Old when\n  and more' },
  dqMulti: { name: 'name: my-skill', description: 'description: "Old desc\n  continued here"', when: 'when_to_use: "Old when\n  and more"' },
  sqMulti: { name: 'name: my-skill', description: "description: 'Old desc\n  continued here'", when: "when_to_use: 'Old when\n  and more'" },
  nextLine: { name: 'name: my-skill', description: 'description:\n  Old desc on next line', when: 'when_to_use:\n  Old when next' },
  plainComment: { name: 'name: my-skill # n', description: 'description: Old desc   # why', when: 'when_to_use: Old when #tight' },
  dqComment: { name: 'name: "my-skill" # n', description: 'description: "Old desc" # why', when: 'when_to_use: "Old when" # tight' },
  literalComment: { name: 'name: my-skill', description: 'description: | # why\n  Old desc', when: 'when_to_use: >- # tight\n  Old when' },
  nullWhen: { name: 'name: my-skill', description: 'description: Old desc', when: 'when_to_use:' },
};

const cases = [];
const record = (label, markdown, fields, body = BODY) => {
  let output = null;
  let error = null;
  try {
    output = markdown === null ? doc.createSkillDocument({ ...fields, body }) : doc.updateSkillDocument(markdown, { ...fields, body });
  } catch (e) {
    error = e.message;
  }
  cases.push({
    label,
    markdown,
    fields,
    body,
    output,
    error,
    stable: markdown === null || error ? null : stableFront(markdown),
  });
};
const wrap = (front) => `---\n${front}\n---\n\nOld body\n`;

for (const [style, old] of Object.entries(olds)) {
  for (const [i, value] of values.entries()) {
    record(`${style} #${i}`, wrap([old.name, old.description, old.when].join('\n')), { name: 'my-skill', description: value, whenToUse: value });
  }
}
for (const [style, old] of Object.entries(olds)) {
  for (const i of [0, 45]) {
    const markdown = wrap([old.name, old.description, old.when].join('\n'));
    const fields = { name: 'my-skill', description: values[i], whenToUse: values[i] };
    record(`${style} crlf #${i}`, markdown.replace(/\n/g, '\r\n'), fields);
    record(`${style} bom #${i}`, `\uFEFF${markdown}`, fields);
  }
}
for (const [i, value] of values.entries()) {
  record(`create #${i}`, null, { name: 'my-skill', description: value, whenToUse: value });
  record(`create-desc-only #${i}`, null, { name: 'my-skill', description: value, whenToUse: '' });
}

const f = { name: 'my-skill', description: 'New description here', whenToUse: 'New trigger' };
const structural = {
  topComment: '# top comment\nname: my-skill\ndescription: Old\nwhen_to_use: Old when',
  topCommentBlank: '# top comment\n\nname: my-skill\ndescription: Old\nwhen_to_use: Old when',
  midComment: 'name: my-skill\n# about description\ndescription: Old\n# about trigger\nwhen_to_use: Old when',
  midCommentBlank: 'name: my-skill\n\n# about description\n\ndescription: Old\n\n# about trigger\n\nwhen_to_use: Old when',
  bottomComment: 'name: my-skill\ndescription: Old\nwhen_to_use: Old when\n# bottom comment',
  bottomCommentBlank: 'name: my-skill\ndescription: Old\nwhen_to_use: Old when\n\n# bottom comment',
  blankBetween: 'name: my-skill\n\ndescription: Old\n\nwhen_to_use: Old when\n\nlicense: MIT',
  extraKeys: 'name: my-skill\ndescription: Old\nlicense: MIT\nwhen_to_use: Old when\nmetadata:\n  author: me\n  requires: [jsRuntime]\nallowed-tools: Read, Write',
  extraNested: 'name: my-skill\nmetadata:\n  deep:\n    a: 1\n    b:\n      - x\n      - y\ndescription: Old',
  extraSeq: 'tags:\n  - one\n  - two\nname: my-skill\ndescription: Old',
  extraLongValue: `name: my-skill\ndescription: Old\nnotes: ${long(40)}`,
  extraBlock: 'name: my-skill\nscript: |\n  echo one\n  echo two\n\nafter: yes\ndescription: Old',
  extraQuotedKeys: '"name": my-skill\n\'description\': Old\nother: "q"',
  reordered: 'when_to_use: Old when\ndescription: Old\nname: my-skill',
  missingWhen: 'name: my-skill\ndescription: Old',
  missingWhenWithExtra: 'name: my-skill\ndescription: Old\nlicense: MIT',
  missingWhenTrailingComment: 'name: my-skill\ndescription: Old\n# trailing',
  missingDescription: 'name: my-skill\nlicense: MIT',
  missingName: 'description: Old\nlicense: MIT',
  onlyName: 'name: my-skill',
  nullName: 'name:\ndescription: Old',
  indentedKeysComment: 'name: my-skill\ndescription: Old\n  # indented comment\nwhen_to_use: Old when',
  anchorsOther: 'base: &b value\nname: my-skill\ndescription: Old\nref: *b',
  tabsAfterColon: 'name:\tmy-skill\ndescription:    Old',
  spaceBeforeColon: 'name : my-skill\ndescription : Old',
  windowsKeys: 'name: my-skill\r\ndescription: Old\r\nwhen_to_use: Old when\r\nlicense: MIT',
  crlfBlock: 'name: my-skill\r\ndescription: |\r\n  Old line\r\n  second\r\nlicense: MIT',
  deleteWhenWithComment: 'name: my-skill\ndescription: Old\n# trigger note\nwhen_to_use: Old when\nlicense: MIT',
  deleteWhenInline: 'name: my-skill\ndescription: Old\nwhen_to_use: Old when # keep?\nlicense: MIT',
  deleteWhenBlock: 'name: my-skill\ndescription: Old\nwhen_to_use: |\n  Old when\n  more\nlicense: MIT',
  deleteWhenLast: 'name: my-skill\ndescription: Old\nwhen_to_use: Old when',
  deleteWhenFirst: 'when_to_use: Old when\nname: my-skill\ndescription: Old',
  deleteWhenBlankBefore: 'name: my-skill\n\nwhen_to_use: Old when\n\ndescription: Old',
  flowMap: '{name: my-skill, description: Old}',
  anchorValue: 'name: &n my-skill\ndescription: Old',
  tagValue: 'name: !!str my-skill\ndescription: Old',
  aliasValue: 'x: &a Old\nname: my-skill\ndescription: *a',
  commentOnKeyLine: 'name: my-skill\ndescription: # why\n  Old desc',
  deleteFirstTopComment: '# top comment\n\nwhen_to_use: Old when\nname: my-skill\ndescription: Old',
  deleteFirstTopCommentTight: '# top comment\nwhen_to_use: Old when\nname: my-skill\ndescription: Old',
  deleteMidTwoBlank: 'name: my-skill\n\n\n# note\n\n\nwhen_to_use: Old when\n\n\ndescription: Old',
  nullWhenComment: 'name: my-skill\ndescription: Old\nwhen_to_use: # c',
  nullWhenCommentMid: 'name: my-skill\nwhen_to_use: # c\ndescription: Old',
  nextLineComments: 'name: my-skill\ndescription:\n  # one\n  # two\n  Old desc\nlicense: MIT',
  nextLineBlankBefore: 'name: my-skill\ndescription:\n\n  Old desc\nlicense: MIT',
  keyTrailingSpaces: 'name: my-skill  \ndescription:   \n  Old desc  \nlicense: MIT',
  plainThreeLines: 'name: my-skill\ndescription: Old one\n  two\n\n  three # tail\nlicense: MIT',
  dqEscapes: 'name: my-skill\ndescription: "Old \\"q\\" \\\\ \\n x"\nlicense: MIT',
  sqEscapes: "name: my-skill\ndescription: 'It''s old'\nlicense: MIT",
  literalIndent4: 'name: my-skill\ndescription: |\n    Old four\n    more\nlicense: MIT',
  literalIndicator: 'name: my-skill\ndescription: |2\n   Old\nlicense: MIT',
  literalBlankInside: 'name: my-skill\ndescription: |\n  Old one\n\n  Old two\n\nlicense: MIT',
  literalCommentLines: 'name: my-skill\ndescription: |\n  Old one\n# after\nlicense: MIT',
  commentAfterValueIndented: 'name: my-skill\ndescription: Old\n  # tail note\nlicense: MIT',
  keyWithHyphenAndDigits: 'name: my-skill\nx-1: y\ndescription: Old',
  docMarkerInside: 'name: my-skill\ndescription: Old',
};
for (const [label, front] of Object.entries(structural)) {
  for (const [variant, fields] of [['both', f], ['noWhen', { ...f, whenToUse: '' }]]) {
    record(`${label} ${variant}`, wrap(front), fields);
    if (!front.includes('\r')) record(`${label} ${variant} crlf`, wrap(front).replace(/\n/g, '\r\n'), fields);
    record(`${label} ${variant} bom`, `\uFEFF${wrap(front)}`, fields);
  }
}
for (const [label, markdown] of Object.entries({
  noFrontmatter: 'Just text',
  notMapping: '---\n- a\n- b\n---\nbody',
  invalidYaml: '---\nname: [unclosed\n---\nbody',
  duplicateKey: '---\nname: a\nname: b\n---\nbody',
  trailingSpacesFence: '---  \nname: my-skill\ndescription: Old\n---  \n\nOld',
  noBodyAfter: '---\nname: my-skill\ndescription: Old\n---',
  fenceOnly: '---\nname: my-skill\ndescription: Old\n---\n',
})) {
  record(label, markdown, f);
}
record('badName', wrap('name: x\ndescription: y'), { ...f, name: 'Bad Name' });
record('emptyBody', wrap('name: x\ndescription: y'), f, '   \n');
record('crlfBody', wrap('name: x\ndescription: y'), f, '\r\n# H\r\n\r\ntext\r\n\r\n');
record('bodyTrim', wrap('name: x\ndescription: y'), f, '\n\n  indented first\nlast  \n\n');
record('trimmedFields', wrap('name: x\ndescription: y'), { name: '  my-skill  ', description: '  padded  ', whenToUse: '  trig  ' });

writeFileSync(out, JSON.stringify({ cases }, null, 1));
console.log(cases.length, 'cases', cases.filter((c) => c.error).length, 'errors');
