import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import i18next, { SUPPORTED_UI_LANGUAGES, t } from './i18n.ts';
import { skillDisplayDescription } from './skill-presentation.ts';
import { selectableComposerSkills } from './composer-skill.ts';
import { BUILT_IN_FEATURES } from './settings/built-in-feature-registry.ts';

const names = [
  'browser-use', 'computer-use', 'docx', 'pdf', 'xlsx', 'pptx', 'image', 'video',
  'goal-management', 'history-recall', 'memory-management', 'local-provider', 'setup', 'skill-creator',
];

test('every shipped skill and built-in feature has translated UI descriptions in every supported non-English language', async () => {
  await i18next.changeLanguage('en');
  const originals = names.map(name => skillDisplayDescription({ name, source: 'builtin', description: 'MODEL_ONLY_TEXT' }));
  assert.ok(originals.every(description => description !== 'MODEL_ONLY_TEXT'));
  try {
    for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
      if (language === 'en') continue;
      const catalog = JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), 'utf8'));
      i18next.addResourceBundle(language, 'translation', catalog);
      await i18next.changeLanguage(language);
      for (const [index, name] of names.entries()) {
        const skill = { name, source: 'builtin', description: 'MODEL_ONLY_TEXT', enabled: true };
        const description = skillDisplayDescription(skill);
        assert.notEqual(description, originals[index], `${language}: ${name}`);
        assert.notEqual(description, 'MODEL_ONLY_TEXT');
        assert.ok(description.trim());
        assert.equal(selectableComposerSkills({ skills: [skill] })[0].description, description);
        assert.equal(skill.description, 'MODEL_ONLY_TEXT');
      }
      for (const feature of BUILT_IN_FEATURES) {
        assert.notEqual(t(feature.description), feature.description, `${language}: ${feature.id}`);
      }
    }
  } finally {
    await i18next.changeLanguage('en');
  }
});

test('custom skills and plugin skills retain their authors descriptions even when their names match built-ins', async () => {
  const catalog = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
  i18next.addResourceBundle('ko', 'translation', catalog);
  await i18next.changeLanguage('ko');
  try {
    for (const source of ['global', 'plugin']) {
      assert.equal(skillDisplayDescription({ name: 'pdf', source, description: 'Author wording' }), 'Author wording');
    }
    assert.equal(
      skillDisplayDescription({ name: 'pdf', owner: { kind: 'builtin' }, description: 'MODEL_ONLY_TEXT' }),
      'PDF 문서를 읽고 만들고 편집합니다.',
    );
    assert.equal(skillDisplayDescription({ name: 'future-skill', source: 'builtin', description: 'Future description' }), 'Future description');
  } finally {
    await i18next.changeLanguage('en');
  }
});
