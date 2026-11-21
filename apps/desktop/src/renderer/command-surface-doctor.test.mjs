import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DoctorBody, doctorReport } from './command-surface-doctor.tsx';

const result = {
  summary: { ok: 1, warn: 1, fail: 1 },
  checks: [
    { id: 'mixdog', label: 'mixdog', level: 'ok', detail: 'v1.0.0 · up to date' },
    { id: 'mcp', label: 'mcp', level: 'warn', detail: '0/1 connected', fix: { command: '/mcp' } },
    { id: 'node', label: 'node', level: 'fail', detail: 'v20.0.0', fix: { hint: 'install Node.js ^22.19.0' } },
  ],
};

test('doctor report parsing puts problems first and rejects non-reports', () => {
  const report = doctorReport(result);
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.level]),
    [
      ['node', 'fail'],
      ['mcp', 'warn'],
      ['mixdog', 'ok'],
    ]
  );
  assert.deepEqual(report.summary, { ok: 1, warn: 1, fail: 1 });
  assert.equal(doctorReport('old text report'), null);
  assert.equal(doctorReport(undefined), null);
  assert.deepEqual(doctorReport({ busy: true }).busy, true);
});

async function mountDoctor() {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'Event'],
  });
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const opened = [];
  const rerun = { count: 0 };
  const render = (value, running = false) =>
    act(async () => {
      root.render(
        React.createElement(DoctorBody, {
          value,
          running,
          onRerun: () => {
            rerun.count += 1;
          },
          onOpenSettings: (section) => opened.push(section),
        })
      );
    });
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
  };
  return { container, opened, rerun, render, close };
}

test('doctor dialog shows the verdict and the settings fix of each check', async () => {
  const { container, opened, render, close } = await mountDoctor();
  try {
    await render(result);
    assert.equal(container.querySelector('.doctor-surface-summary').dataset.level, 'fail');
    const rows = [...container.querySelectorAll('.doctor-check')];
    assert.deepEqual(
      rows.map((row) => row.dataset.level),
      ['fail', 'warn', 'ok']
    );
    assert.match(rows[0].textContent, /install Node\.js \^22\.19\.0/);
    assert.equal(rows[0].querySelector('.doctor-check-fix'), null);
    assert.equal(rows[2].querySelector('.doctor-check-fix'), null);
    await act(async () => rows[1].querySelector('.doctor-check-fix').click());
    assert.deepEqual(opened, ['mcp']);
  } finally {
    await close();
  }
});

test('doctor dialog re-runs the diagnostics and disables the button while they run', async () => {
  const { container, rerun, render, close } = await mountDoctor();
  try {
    await render(result);
    await act(async () => container.querySelector('.doctor-surface-actions button').click());
    assert.equal(rerun.count, 1);
    await render(result, true);
    assert.equal(container.querySelector('.doctor-surface-actions button').disabled, true);
  } finally {
    await close();
  }
});

test('doctor dialog shows only the busy notice while another command runs', async () => {
  const { container, render, close } = await mountDoctor();
  try {
    await render({ busy: true });
    assert.equal(container.querySelector('.doctor-check'), null);
    assert.match(container.textContent, /Another command is running/);
  } finally {
    await close();
  }
});
