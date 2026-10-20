// Korean particles after a name: chosen by the last syllable's 받침, so the
// copy reads "나비가" / "봄이" instead of "나비이(가)".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, { expose: ['HTMLElement', 'Node', 'Element'] });
const { default: React } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { koParticle, resolveKoParticles, markKoValue } = await import('../shared/ko-particle.ts');
const { default: i18n, t: translate } = await import('./i18n.ts');
const { AgentInstructionEditors } = await import('./agent-instruction-editors.tsx');
const { publishMixyStatus, resetMixyStatus } = await import('./mixy-identity.ts');

test('the particle follows the last Hangul syllable: 받침 or not', () => {
  assert.equal(koParticle('나비', '이/가'), '가');
  assert.equal(koParticle('봄', '이/가'), '이');
  assert.equal(koParticle('나비', '을/를'), '를');
  assert.equal(koParticle('봄', '을/를'), '을');
  assert.equal(koParticle('나비', '은/는'), '는');
  assert.equal(koParticle('봄', '은/는'), '은');
  assert.equal(koParticle('나비', '과/와'), '와');
  assert.equal(koParticle('봄', '과/와'), '과');
});

test('으로/로: no 받침 or a ㄹ 받침 takes 로', () => {
  assert.equal(koParticle('나비', '으로/로'), '로');
  assert.equal(koParticle('서울', '으로/로'), '로');
  assert.equal(koParticle('봄', '으로/로'), '으로');
});

test('a Latin end reads as no 받침; a digit as its Korean reading', () => {
  assert.equal(koParticle('Mixy', '이/가'), '가');
  assert.equal(koParticle('Mixy', '을/를'), '를');
  assert.equal(koParticle('Agent 3', '이/가'), '이', '삼');
  assert.equal(koParticle('Agent 2', '이/가'), '가', '이');
  assert.equal(koParticle('Agent 7', '으로/로'), '로', '칠');
  assert.equal(koParticle('Agent 6', '으로/로'), '으로', '육');
  assert.equal(koParticle('Agent 0', '은/는'), '은', '영');
});

test('only a dual form right after an interpolated value is resolved', () => {
  assert.equal(resolveKoParticles(`${markKoValue('나비')}을(를) 저장했습니다`), '나비를 저장했습니다');
  assert.equal(resolveKoParticles(`${markKoValue('봄')}(으)로 이동`), '봄으로 이동');
  assert.equal(resolveKoParticles(`값 ${markKoValue('Mixy')}`), '값 Mixy', 'marks never show');
  assert.equal(resolveKoParticles('파일이(가) 없습니다'), '파일이(가) 없습니다', 'plain copy is left as written');
});

test('the Korean UI picks the particle; other languages stay as they are', async (t) => {
  const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
  i18n.addResourceBundle('ko', 'translation', ko);
  await i18n.changeLanguage('ko');
  t.after(async () => {
    await i18n.changeLanguage('en');
    resetMixyStatus();
  });
  assert.equal(translate('Saved agent "{{name}}".', { name: '나비' }), '에이전트 "나비"를 저장했습니다.');
  assert.equal(translate('Saved agent "{{name}}".', { name: '봄' }), '에이전트 "봄"을 저장했습니다.');
  // A rendered surface names the representative generically, whatever its name.
  publishMixyStatus({ created: true, name: '나비' });
  const html = renderToStaticMarkup(
    React.createElement(AgentInstructionEditors, {
      persona: '',
      body: '',
      disabled: false,
      mixy: true,
      onPersona() {},
      onBody() {},
    })
  );
  assert.match(html, /placeholder="대표 봇이 일하는 방식을 적어 주세요/);
  assert.doesNotMatch(html, /나비|\(가\)/);
  await i18n.changeLanguage('en');
  assert.equal(translate('Saved agent "{{name}}".', { name: '나비' }), 'Saved agent "나비".');
});
