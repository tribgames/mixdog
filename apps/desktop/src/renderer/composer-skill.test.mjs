import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { selectableComposerSkills, withSelectedSkill, useComposerSkill, shouldRemoveSelectedSkill } from './composer-skill.ts';
import { useComposerSubmission } from './use-composer-submission.ts';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.mixdogDesktop = { rendererDiagnostic() {} };
dom.window.HTMLElement.prototype.attachEvent ??= () => {};
dom.window.HTMLElement.prototype.detachEvent ??= () => {};

test('Backspace removes the skill only at the unselected start, without stealing text deletion or IME keys', () => {
  const input = { selected: 'pdf', key: 'Backspace', start: 0, end: 0, composing: false };
  assert.equal(shouldRemoveSelectedSkill(input), true);
  for (const change of [
    { selected: '' }, { key: 'Delete' }, { start: 1, end: 1 }, { end: 3 },
    { composing: true }, { repeat: true }, { modified: true },
  ]) {
    assert.equal(shouldRemoveSelectedSkill({ ...input, ...change }), false);
  }
});

test('menu offers enabled built-in and custom skills, not disabled or unavailable entries', () => {
  assert.deepEqual(selectableComposerSkills({ skills: [
    { name: 'pdf', enabled: true, description: 'PDF files' },
    { name: 'private-skill', enabled: true },
    { name: 'disabled', enabled: false },
    { name: 'unknown-status' },
    { name: 'pdf', enabled: true },
  ] }), [{ name: 'pdf', description: 'PDF files' }, { name: 'private-skill', description: '' }]);
});

test('explicit selection preserves multimodal attachments and does not claim the skill already ran', () => {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const pdf = { type: 'file', data: 'BBBB', mimeType: 'application/pdf', filename: 'report.pdf' };
  const content = [{ type: 'text', text: 'Review this' }, image, pdf];
  const result = withSelectedSkill(content, 'pdf');
  assert.deepEqual(result.slice(1), content);
  assert.match(result[0].text, /Load it with the Skill tool/);
  assert.equal(withSelectedSkill(content, ''), content);
});

test('selection survives rejected submission and scope switches, clears only after acceptance', async () => {
  let current;
  const submissions = [];
  let accept = false;
  function Harness({ scope }) {
    const skill = useComposerSkill(scope);
    const [draft, setDraft] = useState('Make a report');
    const [, setSubmitting] = useState(false);
    const [, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft); draftRef.current = draft;
    const textarea = useRef(null);
    const attachmentsRef = useRef([]);
    current = { skill, draft, setDraft, ...useComposerSubmission({
      turnBusy: false, commandBusy: false, recoveryScope: scope, textarea, draftRef,
      attachmentsRef, transitioningRef: useRef(false), composingRef: useRef(false),
      submittingRef: useRef(false), submissionRetryRef: useRef(null),
      mountedRef: useRef(true), historyNavigation: useRef({ index: -1, seed: '' }),
      setDraft, setSubmitting, setSubmissionRecoveryVersion,
      clearNotice() {}, setAttachmentError() {}, removeAttachments() {},
      mergeRestoredAttachments: (_attachments, text) => text,
      restoredAttachments: (_value, text) => ({ attachments: [], text }),
      executeSlash: async () => true, rememberPrompt() {},
      selectedSkill: skill.name, onSkillSubmitted: skill.submitted,
      submit: async (content, options) => { submissions.push({ content, options }); return accept; },
      abort: async () => ({}),
    }) };
    return React.createElement('textarea', { ref: textarea, value: draft, readOnly: true });
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness, { scope: 'skill-test-a' })));
    await act(async () => current.skill.select('pdf'));
    assert.equal(submissions.length, 0);
    await act(async () => current.send());
    assert.equal(current.skill.name, 'pdf');
    assert.match(submissions[0].content, /skill "pdf"/);
    assert.equal(submissions[0].options.displayText, '[PDF] Make a report');
    await act(async () => root.render(React.createElement(Harness, { scope: 'skill-test-b' })));
    assert.equal(current.skill.name, '');
    await act(async () => root.render(React.createElement(Harness, { scope: 'skill-test-a' })));
    assert.equal(current.skill.name, 'pdf');
    await act(async () => current.setDraft('Make a report'));
    accept = true;
    await act(async () => current.send());
    assert.equal(current.skill.name, '');
    assert.equal(submissions[0].options.id, submissions[1].options.id);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
