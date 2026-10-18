import assert from 'node:assert/strict';
import test from 'node:test';
import { oauthErrorHtml, oauthSuccessHtml } from './lib/oauth-page.mjs';

test('the success page is branded, bilingual and offers a close button', () => {
  const html = oauthSuccessHtml('Codex');
  assert.match(html, /<svg[\s\S]*<\/svg>/);
  assert.match(html, /로그인 완료/);
  assert.match(html, /Codex 로그인이 완료되었습니다\. 이 탭을 닫고 Mixdog로 돌아가 주세요\./);
  assert.match(html, /You can close this tab and return to Mixdog/);
  assert.match(html, /<button type="button" onclick="window\.close\(\)">닫기 · Close<\/button>/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<a\s/);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
});

test('a known language renders a single copy', () => {
  const ko = oauthSuccessHtml('X', { lang: 'ko' });
  assert.match(ko, /<html lang="ko">/);
  assert.doesNotMatch(ko, /You can close/);
  const en = oauthErrorHtml('boom', { lang: 'en' });
  assert.match(en, /Sign-in failed/);
  assert.doesNotMatch(en, /로그인 실패/);
});

test('the failure page shows the escaped reason', () => {
  const html = oauthErrorHtml('<img src=x onerror=alert(1)> & "q"');
  assert.match(html, /로그인 실패/);
  assert.match(html, /Sign-in failed/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /window\.close\(\)/);
});

test('provider names are escaped on the success page', () => {
  const html = oauthSuccessHtml('<b>x</b>');
  assert.ok(!html.includes('<b>x'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});
