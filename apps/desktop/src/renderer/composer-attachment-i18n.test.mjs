import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import i18n from './i18n';
import { attachmentPolicyError, remoteAttachmentSizeError } from './composer-attachments';
import { MAX_COMPOSER_ATTACHMENTS } from './composer-support';
import { uiNumber } from './ui-format';
import { composerSubmitErrorText } from './composer-submit-error';
import { relativeAge } from './pull-requests-model';
import { localizedAttachmentName } from './attachment-name';
import { effortTierLabel } from './effort-tier-label';
import { attachmentSummary, textWithoutAttachmentTokens } from './message-attachment-summary';
import { restoreAttachmentsFromRecord } from './composer-attachment-restore';
import { pastedTextFields } from './composer-support';
import { FRAME_NOT_SENT_MESSAGE } from '../shared/remote-transport';

const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
const de = JSON.parse(readFileSync(new URL('./locales/de.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ko', 'translation', ko);
i18n.addResourceBundle('de', 'translation', de);
const ru = JSON.parse(readFileSync(new URL('./locales/ru.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ru', 'translation', ru);

test('attachment refusals and numbers follow the UI language', async () => {
  await i18n.changeLanguage('ko');
  const full = Array.from({ length: MAX_COMPOSER_ATTACHMENTS }, (_, id) => ({
    id,
    name: 'a.txt',
    kind: 'text',
    mimeType: 'text/plain',
    data: 'x',
    token: '',
  }));
  assert.equal(
    attachmentPolicyError(full, { ...full[0], id: 99 }),
    `한 번에 최대 ${MAX_COMPOSER_ATTACHMENTS}개까지 첨부할 수 있습니다.`
  );
  assert.match(remoteAttachmentSizeError('b.png', 5 * 1024 * 1024, 1024 * 1024), /^b\.png: 5\.0 ?MB.*한도/);
  await i18n.changeLanguage('de');
  assert.equal(uiNumber(1234567), '1.234.567');
  await i18n.changeLanguage('en');
  assert.equal(uiNumber(1234567), '1,234,567');
});

test('a send the relay refused, a pull-request age and a context size read in the UI language', async () => {
  await i18n.changeLanguage('ko');
  assert.match(composerSubmitErrorText(new Error(FRAME_NOT_SENT_MESSAGE)), /연결이 끊겼습니다/);
  assert.equal(relativeAge(new Date(Date.now() - 3 * 60_000).toISOString()), '3분');
  await i18n.changeLanguage('en');
  assert.equal(relativeAge(new Date(Date.now() - 3 * 60_000).toISOString()), '3m');
});
test('a pasted-text chip shows a localized name while restore and the summary still find its token', async () => {
  await i18n.changeLanguage('ko');
  const fields = pastedTextFields(1, 'a\nb\nc');
  assert.equal(fields.token, '[Pasted text #1 +3 lines]');
  assert.equal(localizedAttachmentName(fields.name), '붙여넣은 텍스트 · 3줄');
  assert.equal(localizedAttachmentName('Pasted text 2'), '붙여넣은 텍스트 2');
  assert.equal(localizedAttachmentName('report.md'), 'report.md');
  const text = `look ${fields.token} please`;
  assert.equal(attachmentSummary(text), '붙여넣기 3줄');
  assert.equal(textWithoutAttachmentTokens(text), 'look please');
  const restored = restoreAttachmentsFromRecord(
    { pastedTexts: { 1: { id: 1, text: 'a\nb\nc', source: 'paste' } } },
    text,
    { reservedIds: new Set(), sequence: { current: 1 } }
  );
  assert.equal(restored.attachments.length, 1);
  assert.equal(restored.attachments[0].token, fields.token);
  await i18n.changeLanguage('en');
});

test('a pasted-text line count takes the plural form of the UI language', async () => {
  await i18n.changeLanguage('en');
  assert.equal(localizedAttachmentName('Pasted text · 1 lines'), 'Pasted text · 1 line');
  await i18n.changeLanguage('de');
  assert.equal(localizedAttachmentName('Pasted text · 1 lines'), 'Eingefügter Text · 1 Zeile');
  await i18n.changeLanguage('ru');
  assert.equal(localizedAttachmentName('Pasted text · 3 lines'), 'Вставленный текст · 3 строки');
  assert.equal(localizedAttachmentName('Pasted text · 5 lines'), 'Вставленный текст · 5 строк');
  await i18n.changeLanguage('en');
});

test('reasoning effort tiers are named by their id in the UI language, and English keeps the core label', async () => {
  assert.equal(effortTierLabel('xhigh', 'Extra high'), 'Extra high');
  await i18n.changeLanguage('ko');
  assert.equal(effortTierLabel('low', 'Low'), '낮음');
  assert.equal(effortTierLabel('xhigh', 'XHigh'), '매우 높음');
  assert.equal(effortTierLabel('custom-tier', 'Custom'), 'Custom');
  assert.equal(effortTierLabel('none', 'None'), '없음');
  await i18n.changeLanguage('en');
});

test('one English word keeps separate keys per meaning', async () => {
  await i18n.changeLanguage('en');
  assert.equal(i18n.t('Profile: Title'), 'Title');
  assert.equal(i18n.t('Git remote: Fetch'), 'Fetch');
  await i18n.changeLanguage('ko');
  assert.notEqual(i18n.t('Profile: Title'), i18n.t('Title'));
  assert.notEqual(i18n.t('Git remote: Fetch'), i18n.t('Fetch'));
  assert.notEqual(i18n.t('Always allowed: Ask again'), i18n.t('Ask again'));
  assert.notEqual(i18n.t('Imported: Starred'), i18n.t('Starred'));
  await i18n.changeLanguage('en');
});