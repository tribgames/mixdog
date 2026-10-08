import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Element', 'Node', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });

const calls = [];
const snapshot = { orchestrationMode: 'balanced' };
window.mixdogDesktop = {
  rendererDiagnostic() {},
  async invokeCapability(request) {
    calls.push(request);
    if (request.capability === 'listWorkflows') {
      return { value: [{ id: 'default', name: 'Default', active: true }], snapshot: null };
    }
    if (request.capability === 'setOrchestrationMode') return { value: request.args[0], snapshot };
    throw new Error(`Unexpected capability: ${request.capability}`);
  },
};

const { OrchestrationModeSelect, WorkflowSelect } = await import('./model-controls.tsx');
const { storeWorkflowOptions } = await import('./workflow-options-cache.ts');
// The workflow picker only exists where the workspace has a real choice, so the
// shared list is seeded with two packs: this file tests the OPEN menu.
storeWorkflowOptions([
  { value: 'default', label: 'Default', active: true },
  { value: 'solo', label: 'Solo', active: false },
]);
const { ProjectContextSelector } = await import('./composer-support.tsx');
const { OpenSelect } = await import('./OpenSelect.tsx');
const { TooltipLayer } = await import('./TooltipLayer.tsx');
const { initUiLanguage, setUiLanguagePreference, SUPPORTED_UI_LANGUAGES } = await import('./i18n.ts');
const { automationProjectOptions, automationWorkflowOptions } = await import('./automation-editor-support.ts');

const common = { disabled: false, invokeResult: (work) => work(), applySnapshot() {} };
const rect = (top = 600) => ({
  x: 300,
  y: top,
  left: 300,
  right: 460,
  top,
  bottom: top + 28,
  width: 160,
  height: 28,
});

async function mount(element, t) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(React.createElement(React.Fragment, null, element, React.createElement(TooltipLayer)))
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const trigger = host.querySelector('[role="combobox"]');
  trigger.getBoundingClientRect = () => rect();
  const pill = trigger.closest('.composer-project-context');
  if (pill) pill.getBoundingClientRect = () => rect();
  return trigger;
}

async function hover(target, expected) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
    target.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 620));
  });
  assert.equal(document.querySelector('[role="tooltip"]')?.textContent, expected);
  assert.equal(target.getAttribute('aria-description'), expected);
  await act(async () => target.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true })));
}

const copy = {
  en: {
    tips: ['Select project', 'Select workflow', 'Delegation mode'],
    modes: [
      ['Solo', 'No delegation'],
      ['Assisted', 'Supporting delegation'],
      ['Collaborative', 'Balanced delegation'],
      ['Swarm', 'Maximum delegation'],
    ],
  },
  ko: {
    tips: ['프로젝트 선택', '워크플로우 선택', '위임 방식'],
    modes: [
      ['단독', '위임 없음'],
      ['보조', '보조 위임'],
      ['분담', '분담 위임'],
      ['스웜', '최대 위임'],
    ],
  },
};

for (const language of ['en', 'ko']) {
  for (const [index, control] of ['project', 'workflow', 'orchestration'].entries()) {
    test(`${language}: ${control} opens above the input without a header and with a working hover description`, async (t) => {
      setUiLanguagePreference(language);
      await initUiLanguage();
      const expected = copy[language];
      const elements = {
        project: () =>
          React.createElement(ProjectContextSelector, {
            projects: [],
            activePath: '',
            activeLabel: '',
            disabled: false,
            onClear() {},
            onSelect() {},
          }),
        workflow: () => React.createElement(WorkflowSelect, common),
        orchestration: () => React.createElement(OrchestrationModeSelect, { ...common, mode: 'none' }),
      };
      const element = elements[control]();
      const trigger = await mount(element, t);
      await hover(trigger, expected.tips[index]);
      await act(async () => trigger.click());
      const menu = document.querySelector('[role="listbox"]');
      assert.ok(menu);
      assert.equal(menu.style.top, '');
      assert.ok(parseFloat(menu.style.bottom) >= 900 - rect().top);
      // The menu opens straight on its options: no header row (user: 팝업
      // 헤더 제거); the trigger's aria-label alone names the listbox.
      assert.equal(menu.getAttribute('aria-labelledby'), null);
      assert.equal(menu.querySelector('.mx-menu-title'), null);
      assert.equal(menu.firstElementChild.getAttribute('role'), 'option');
      if (control === 'orchestration') {
        const options = [...menu.querySelectorAll('[role="option"]')];
        assert.equal(options.length, 4);
        for (const [optionIndex, option] of options.entries()) {
          assert.equal(option.textContent, expected.modes[optionIndex][0]);
          await hover(option, expected.modes[optionIndex][1]);
        }
      }
    });
  }
}

test('orchestration keyboard selection lands on the first option and changes only the draft', async (t) => {
  const changes = [];
  const trigger = await mount(
    React.createElement(OrchestrationModeSelect, {
      ...common,
      mode: 'none',
      onDraftChange: (mode) => changes.push(mode),
    }),
    t
  );
  calls.length = 0;
  await act(async () =>
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  );
  const menu = document.querySelector('[role="listbox"]');
  assert.equal(document.activeElement, menu.querySelector('[role="option"]'));
  await act(async () => menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  assert.equal(document.activeElement, menu.querySelectorAll('[role="option"]')[3]);
  await act(async () =>
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  assert.deepEqual(changes, ['swarm']);
  assert.deepEqual(calls, []);
  assert.equal(document.querySelector('[role="listbox"]'), null);
  assert.equal(document.activeElement, trigger);
});

test('session mode selection still applies the returned snapshot', async (t) => {
  const snapshots = [];
  const trigger = await mount(
    React.createElement(OrchestrationModeSelect, {
      ...common,
      mode: 'none',
      applySnapshot: (value) => snapshots.push(value),
    }),
    t
  );
  calls.length = 0;
  await act(async () => trigger.click());
  await act(async () => document.querySelectorAll('[role="option"]')[2].click());
  assert.deepEqual(calls, [{ capability: 'setOrchestrationMode', args: ['balanced'] }]);
  assert.deepEqual(snapshots, [snapshot]);
  assert.equal(document.querySelector('[role="listbox"]'), null);
});

test('a context menu near the top falls back below and Escape restores focus', async (t) => {
  const trigger = await mount(React.createElement(OrchestrationModeSelect, { ...common, mode: 'none' }), t);
  trigger.getBoundingClientRect = () => rect(16);
  await act(async () => trigger.click());
  const menu = document.querySelector('[role="listbox"]');
  assert.equal(menu.style.bottom, '');
  assert.ok(parseFloat(menu.style.top) >= rect(16).bottom);
  await act(async () => menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="listbox"]'), null);
  assert.equal(document.activeElement, trigger);
});

for (const { value: language } of SUPPORTED_UI_LANGUAGES.filter(({ value }) => value !== 'en')) {
  for (const kind of ['project', 'workflow', 'automation']) {
    test(`${language}: ${kind} picker preserves catalog-colliding custom names in its trigger and menu`, async (ctx) => {
      setUiLanguagePreference(language);
      await initUiLanguage();
      const catalog = JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), 'utf8'));
      const names = [
        'Agent',
        'Settings',
        'History',
        'Default',
        'main',
        'Rename Agent',
        '3 tasks',
        'Agent <&> {{name}}',
      ];
      const projects = names.map((alias, index) => ({ path: `/project/${index}`, name: `folder-${index}`, alias }));
      const workflows = names.map((name, index) => ({ id: `workflow-${index}`, name }));
      const changes = [];
      storeWorkflowOptions(workflows.map((row) => ({ value: row.id, label: row.name })));
      const elements = {
        project: () =>
          React.createElement(ProjectContextSelector, {
            projects,
            activePath: projects[0].path,
            activeLabel: names[0],
            disabled: false,
            onClear() {},
            onSelect: (value) => changes.push(value),
          }),
        workflow: () =>
          React.createElement(WorkflowSelect, {
            ...common,
            workflow: workflows[0],
            onDraftChange: (value) => changes.push(value),
          }),
        automation: () =>
          React.createElement(OpenSelect, {
            ariaLabel: catalog.Project,
            value: projects[0].path,
            tooltip: names[0],
            options: automationProjectOptions(projects, projects[0].path).map((option) => ({
              ...option,
              description: 'History',
            })),
            onChange: (value) => changes.push(value),
          }),
      };
      const trigger = await mount(elements[kind](), ctx);
      assert.equal(trigger.querySelector('.mx-select-value').textContent, names[0]);
      assert.equal(
        trigger.getAttribute('data-tooltip'),
        kind === 'automation' ? names[0] : catalog[kind === 'project' ? 'Select project' : 'Select workflow']
      );
      await act(async () => trigger.click());
      const menu = document.querySelector('[role="listbox"]');
      const options = [...menu.querySelectorAll('[role="option"]')];
      const expected = kind === 'workflow' ? names : [catalog['No project'], ...names];
      assert.deepEqual(
        options.map((option) => option.textContent),
        expected
      );
      if (kind === 'automation') {
        assert.ok(options.every((option) => option.getAttribute('aria-description') === 'History'));
        assert.deepEqual(
          automationWorkflowOptions(workflows).map((option) => option.label),
          names
        );
      }
      await act(async () => options[kind === 'workflow' ? 1 : 2].click());
      assert.deepEqual(changes, [kind === 'workflow' ? workflows[1] : projects[1].path]);
      ctx.after(async () => {
        setUiLanguagePreference('en');
        await initUiLanguage();
      });
    });
  }
}

test('ordinary selects keep downward placement and do not acquire composer-only content', async (t) => {
  const trigger = await mount(
    React.createElement(OpenSelect, {
      ariaLabel: 'Ordinary select',
      options: [{ value: 'one', label: 'One' }],
    }),
    t
  );
  await act(async () => trigger.click());
  const menu = document.querySelector('[role="listbox"]');
  assert.equal(menu.style.bottom, '');
  assert.ok(parseFloat(menu.style.top) >= rect().bottom);
  assert.equal(menu.querySelector('.mx-menu-title'), null);
  assert.equal(trigger.hasAttribute('data-tooltip'), false);
});
