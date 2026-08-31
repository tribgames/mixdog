import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  browserBridgeAvailableSync,
  executeBrowserTool,
} from './browser-bridge/client.mjs';
import {
  BROWSER_ACTIONS,
  BROWSER_OBSERVATION_ACTIONS,
  SEQUENCE_STEP_ACTIONS,
  validateBrowserToolArgs,
} from './browser-bridge/action-schema.mjs';
import { TOOL_DEFS as BROWSER_TOOL_DEFS } from './browser-bridge/tool-defs.mjs';
import {
  computerBridgeAvailableSync,
  deferComputerSessionRelease,
  executeComputerTool,
  isReplaySafeComputerCommand,
  releaseAllComputerSessions,
  releaseComputerSession,
} from './computer-bridge/client.mjs';
import {
  COMPUTER_OBSERVATION_ACTIONS,
  toComputerHostCommand,
  validateComputerToolArgs,
} from './computer-bridge/action-schema.mjs';
import { TOOL_DEFS as COMPUTER_TOOL_DEFS } from './computer-bridge/tool-defs.mjs';

const CLIENTS = [
  {
    name: 'browser',
    file: 'browser-bridge.json',
    available: browserBridgeAvailableSync,
    execute: executeBrowserTool,
  },
  {
    name: 'computer',
    file: 'computer-bridge.json',
    available: computerBridgeAvailableSync,
    execute: executeComputerTool,
  },
];

test('browser tool contract exposes generation-bound actions and bounded observations', () => {
  const schema = BROWSER_TOOL_DEFS[0].inputSchema;
  const input = schema.properties.input;
  assert.deepEqual(schema.required, ['action']);
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.equal(input.additionalProperties, undefined);
  const propertyFor = (_action, name) => input.properties[name];
  assert.deepEqual(Object.keys(schema.properties), ['action', 'input']);
  assert.deepEqual(schema.properties.action.enum, BROWSER_ACTIONS);
  assert.ok(input.description.includes('navigate url'));
  // Token budget: this schema rides every request, so it only grows when the
  // addition pays for itself. `sequence` costs ~800 bytes once and removes up
  // to five whole request round-trips per form, each of which would have
  // carried this very schema again; handoff and extract raised the floor
  // before it, and the surrounding descriptions were compacted to absorb them.
  // `intercept` and `init_script` cost ~1.4 KB together and buy states the
  // page could not otherwise be put into at all: a mocked or refused request,
  // and code running before the document boots.
  assert.ok(Buffer.byteLength(JSON.stringify(BROWSER_TOOL_DEFS[0])) <= 15_000);
  assert.deepEqual(propertyFor('fill', 'fields').items.required, ['ref']);
  assert.equal(propertyFor('fill', 'fields').items.additionalProperties, false);
  assert.equal(propertyFor('fill', 'fields').items.properties.values.minItems, 1);
  assert.equal(propertyFor('fill', 'fields').items.properties.checked.type, 'boolean');
  assert.equal(propertyFor('navigate', 'expect').additionalProperties, false);
  for (const action of [
    'snapshot', 'locate', 'evaluate', 'emulate', 'cookies', 'storage', 'performance',
    'click', 'fill', 'type', 'select', 'check', 'hover', 'drag', 'upload',
    'handle_dialog', 'status', 'console', 'network',
  ]) {
    assert.ok(schema.properties.action.enum.includes(action), action);
  }
  for (const removed of [
    'observe', 'screenshot', 'click_at', 'tap', 'hover_at', 'drag_at', 'swipe', 'fill_form',
  ]) {
    assert.equal(schema.properties.action.enum.includes(removed), false, removed);
  }
  assert.equal(schema.properties.action.enum.length, 34);
  for (const added of ['extract', 'sequence']) {
    assert.ok(schema.properties.action.enum.includes(added), added);
  }
  assert.ok(propertyFor('click', 'ref').description.includes('p1-s3-e12'));
  assert.ok(propertyFor('click', 'snapshotId'));
  assert.deepEqual(propertyFor('snapshot', 'mode').enum, ['semantic', 'visual', 'both']);
  assert.deepEqual(propertyFor('click', 'pointer').enum, ['mouse', 'touch']);
  assert.deepEqual(propertyFor('click', 'button').enum, ['left', 'right', 'middle']);
  assert.deepEqual(propertyFor('click', 'modifiers').items.enum, ['Alt', 'Control', 'Meta', 'Shift']);
  assert.deepEqual(propertyFor('snapshot', 'format').enum, ['jpeg', 'png', 'pdf']);
  assert.equal(propertyFor('snapshot', 'quality').maximum, 100);
  assert.ok(propertyFor('snapshot', 'fullPage'));
  assert.ok(propertyFor('navigate', 'reload'));
  assert.ok(propertyFor('scroll', 'dx'));
  assert.ok(propertyFor('scroll', 'ref'));
  assert.deepEqual(propertyFor('console', 'level').enum, ['all', 'debug', 'info', 'warning', 'error']);
  assert.ok(propertyFor('evaluate', 'script').description.includes('element and this'));
  assert.ok(propertyFor('network', 'requestId').description.includes('headers, bodies'));
  assert.equal(propertyFor('network', 'resourceTypes').items.enum.includes('fetch'), true);
  assert.equal(propertyFor('network', 'limit').maximum, 200);
  assert.equal(propertyFor('network', 'frameLimit').maximum, 200);
  assert.equal(propertyFor('emulate', 'deviceScaleFactor').maximum, 4);
  assert.equal(propertyFor('downloads', 'attach').description.includes('8 MiB'), true);
  assert.ok(propertyFor('drag', 'targetX'));
  assert.ok(BROWSER_TOOL_DEFS[0].description.includes('never replayed after dispatch'));
  assert.ok(BROWSER_TOOL_DEFS[0].description.includes('same assistant turn'));
  assert.ok(BROWSER_TOOL_DEFS[0].description.includes('Do not batch calls that need earlier results'));
  assert.equal(propertyFor('snapshot', 'maxElements').maximum, 500);
  assert.equal(propertyFor('navigate', 'maxChars').maximum, 30_000);
  assert.equal(propertyFor('upload', 'paths').maxItems, 10);
  assert.ok(propertyFor('upload', 'confirm'));
  assert.ok(propertyFor('wait', 'textGone'));
  assert.equal(propertyFor('navigate', 'expect').properties.timeoutMs.maximum, 20_000);
  assert.equal(propertyFor('navigate', 'settleMs').maximum, 5_000);
  assert.equal(propertyFor('navigate', 'includeScreenshot').type, 'boolean');
  assert.equal(propertyFor('snapshot', 'includeScreenshot').type, 'boolean');
  assert.ok(BROWSER_TOOL_DEFS[0].description.includes('untrusted data'));
  assert.ok(BROWSER_TOOL_DEFS[0].description.includes('mode=both'));
});

test('browser action contract validates compact flat-schema calls', () => {
  assert.deepEqual(validateBrowserToolArgs({ action: 'list_tabs' }), {
    ok: true,
    action: 'list_tabs',
    input: {},
  });
  assert.deepEqual(validateBrowserToolArgs({
    action: 'navigate',
    input: { url: 'https://example.com', includeScreenshot: true, maxChars: 8_000 },
  }), {
    ok: true,
    action: 'navigate',
    input: { url: 'https://example.com', includeScreenshot: true, maxChars: 8_000 },
  });
  assert.equal(validateBrowserToolArgs({
    action: 'fill',
    input: {
      fields: [
        { ref: 'p1-s1-e1', text: 'Ada' },
        { ref: 'p1-s1-e2', values: ['engineer'] },
        { ref: 'p1-s1-e3', checked: false },
      ],
    },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'fill',
      input: { fields: [{ ref: 'p1-s1-e1', text: 'Ada', checked: true }] },
    }).error,
    /requires exactly one/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'navigate', input: {} }).error,
    /requires input\.url or input\.reload/,
  );
  assert.equal(validateBrowserToolArgs({
    action: 'navigate',
    input: { reload: true },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'navigate', input: { reload: false } }).error,
    /reload=true/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'click', input: { ref: 'p1-s1-e1', script: '1' } }).error,
    /does not accept input field\(s\): script/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'click',
      input: { ref: 'p1-s1-e1', snapshotId: 'p1-s1', x: 1, y: 1 },
    }).error,
    /accepts only one input target form/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'observe' }).error,
    /unknown browser action "observe"/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'snapshot', input: { includeScreenshot: true } }).error,
    /does not accept input field\(s\): includeScreenshot/,
  );
  assert.equal(validateBrowserToolArgs({
    action: 'snapshot',
    input: { mode: 'visual', fullPage: true, format: 'jpeg', quality: 60 },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'snapshot',
      input: { mode: 'both', fullPage: true },
    }).error,
    /inspection-only/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'snapshot',
      input: { mode: 'visual', format: 'png', quality: 60 },
    }).error,
    /only with input\.format=jpeg/,
  );
  assert.equal(validateBrowserToolArgs({
    action: 'click',
    input: { ref: 'p1-s1-e1', button: 'right', modifiers: ['Control', 'Shift'] },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'click',
      input: { ref: 'p1-s1-e1', pointer: 'touch', button: 'left' },
    }).error,
    /pointer=touch/,
  );
  assert.equal(validateBrowserToolArgs({
    action: 'scroll',
    input: { ref: 'p1-s1-e1', dx: 20, dy: 100 },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'scroll',
      input: { ref: 'p1-s1-e1', snapshotId: 'p1-s1', x: 1, y: 1 },
    }).error,
    /only one input target form/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'upload', input: { ref: 'p1-s1-e1', paths: ['C:\\tmp\\a.txt'], confirm: false } }).error,
    /requires input\.confirm=true/,
  );
});

test('browser sequence chains only deterministic same-page gestures', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'sequence',
    input: {
      steps: [
        { action: 'fill', ref: 'p1-s1-e1', text: 'ada@example.com' },
        { action: 'fill', ref: 'p1-s1-e2', text: 'secret' },
        { action: 'click', ref: 'p1-s1-e3' },
      ],
      expect: { text: 'Welcome' },
    },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'sequence',
      input: { steps: [{ action: 'click', ref: 'p1-s1-e1' }] },
    }).error,
    /2 to 6 steps/,
  );
  // Navigation and uploads keep their own fresh snapshot before the next call.
  assert.match(
    validateBrowserToolArgs({
      action: 'sequence',
      input: {
        steps: [
          { action: 'navigate', url: 'https://example.com' },
          { action: 'click', ref: 'p1-s1-e1' },
        ],
      },
    }).error,
    /action must be one of/,
  );
  // Coordinates bind to a snapshot the earlier steps invalidate.
  assert.match(
    validateBrowserToolArgs({
      action: 'sequence',
      input: {
        steps: [
          { action: 'click', ref: 'p1-s1-e1', x: 10 },
          { action: 'click', ref: 'p1-s1-e2' },
        ],
      },
    }).error,
    /does not accept field\(s\): x/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'sequence',
      input: {
        steps: [
          { action: 'fill', ref: 'p1-s1-e1' },
          { action: 'click', ref: 'p1-s1-e2' },
        ],
      },
    }).error,
    /requires ref\+text/,
  );
});

test('browser extract guards its own inputs', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'extract',
    input: { selector: 'li.product', attributes: ['href', 'data-price'], limit: 20 },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'extract', input: {} }).error,
    /requires input\.selector/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'extract', input: { selector: 'li', attributes: [] } }).error,
    /1 to 12 attribute names/,
  );
});

test('intercept rules replace a payload or refuse a request, never both or neither', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'intercept',
    input: { operation: 'add', url: '*/api/*', abort: true, resourceTypes: ['xhr', 'fetch'] },
  }).ok, true);
  assert.equal(validateBrowserToolArgs({
    action: 'intercept',
    input: { operation: 'add', url: '*/health*', body: '{"status":"down"}' },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'intercept',
      input: { operation: 'add', url: '*/api/*', abort: true, body: 'x' },
    }).error,
    /abort or input\.body, not both/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'intercept', input: { operation: 'add', url: '*/api/*' } }).error,
    /requires input\.abort=true or input\.body/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'intercept', input: { operation: 'add', abort: true } }).error,
    /requires input\.url/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'intercept', input: { operation: 'remove' } }).error,
    /remove requires input\.ruleId/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'intercept',
      input: { operation: 'clear', url: '*/api/*' },
    }).error,
    /clear does not accept input field\(s\): url/,
  );
  // list is the default, so an empty call reports the table instead of failing.
  assert.equal(validateBrowserToolArgs({ action: 'intercept' }).ok, true);
});

test('init_script registers a source and removes it by handle', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'init_script',
    input: { operation: 'add', script: 'window.__seeded = true' },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'init_script', input: { operation: 'add' } }).error,
    /add requires input\.script/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'init_script', input: { operation: 'remove' } }).error,
    /remove requires input\.scriptId/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'init_script',
      input: { operation: 'add', script: 'void 0', scriptId: 'is1' },
    }).error,
    /scriptId belongs to remove/,
  );
});

test('emulate geolocation and headers are refused unless they are usable', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'emulate',
    input: { latitude: 37.5, longitude: 127, accuracy: 25 },
  }).ok, true);
  assert.equal(validateBrowserToolArgs({
    action: 'emulate',
    input: { headers: { 'x-test': 'on' } },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'emulate', input: { latitude: 37.5 } }).error,
    /latitude and input\.longitude together/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'emulate', input: { accuracy: 25 } }).error,
    /accuracy requires latitude and longitude/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'emulate', input: { headers: { 'x-test': 5 } } }).error,
    /header names with string values/,
  );
});

test('a JSON-encoded browser input is accepted the same as the object', () => {
  // Same provider behaviour the computer tool absorbs: a nested object argument
  // can arrive as a JSON string, and a well-formed call must still run.
  assert.equal(validateBrowserToolArgs({ action: 'snapshot', input: '{}' }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'snapshot', input: '{tab:main' }).error,
    /input must be an object/,
  );
});

test('browser runtime manifest rejects removed aliases at the schema boundary', () => {
  assert.deepEqual(SEQUENCE_STEP_ACTIONS, [
    'click', 'fill', 'type', 'select', 'check', 'hover', 'press', 'scroll', 'wait',
  ]);
  for (const removed of [
    'observe', 'screenshot', 'click_at', 'tap', 'hover_at', 'drag_at', 'swipe', 'fill_form',
  ]) {
    assert.equal(BROWSER_ACTIONS.includes(removed), false, removed);
    assert.match(
      validateBrowserToolArgs({ action: removed }).error,
      new RegExp(`unknown browser action "${removed}"`),
    );
  }
});

test('asking where an image goes only makes sense where an image exists', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'snapshot',
    input: { mode: 'visual', image_output: 'file' },
  }).ok, true);
  assert.equal(validateBrowserToolArgs({
    action: 'click',
    input: { ref: 'p1-s1-e1', includeScreenshot: true, image_output: 'file' },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'click', input: { ref: 'p1-s1-e1', image_output: 'file' } }).error,
    /require input\.includeScreenshot=true/,
  );
  assert.match(
    validateBrowserToolArgs({ action: 'snapshot', input: { image_output: 'file' } }).error,
    /require input\.mode=visual or input\.mode=both/,
  );
});

test('printing a page is a visual snapshot that always answers with a file', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'snapshot',
    input: { mode: 'visual', format: 'pdf' },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'snapshot', input: { mode: 'both', format: 'pdf' } }).error,
    /requires action "snapshot" with input\.mode=visual/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'snapshot',
      input: { mode: 'visual', format: 'pdf', quality: 60 },
    }).error,
    /only with input\.format=jpeg/,
  );
  assert.match(
    validateBrowserToolArgs({
      action: 'snapshot',
      input: { mode: 'visual', format: 'pdf', image_output: 'inline' },
    }).error,
    /always writes a file/,
  );
});

test('scroll accepts a text target, and only one target form at a time', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'scroll',
    input: { text: 'Pricing' },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({
      action: 'scroll',
      input: { text: 'Pricing', ref: 'p1-s1-e2' },
    }).error,
    /only one input target form/,
  );
});

test('select reads its options when no value is given, and still selects when one is', () => {
  assert.equal(validateBrowserToolArgs({
    action: 'select',
    input: { ref: 'p1-s1-e2' },
  }).ok, true);
  assert.equal(validateBrowserToolArgs({
    action: 'select',
    input: { ref: 'p1-s1-e2', values: ['Seoul'] },
  }).ok, true);
  assert.match(
    validateBrowserToolArgs({ action: 'select', input: { values: ['Seoul'] } }).error,
    /requires input\..*ref/,
  );
});

test('the observation-only actions named on each tool surface are valid actions', () => {
  for (const action of BROWSER_OBSERVATION_ACTIONS) {
    assert.ok(BROWSER_ACTIONS.includes(action), `browser schema missing ${action}`);
  }
  // The computer tool's actions map onto host commands, so the claim is checked
  // against what the client counts as a read.
  for (const action of COMPUTER_OBSERVATION_ACTIONS) {
    const input = action === 'list'
      ? { kind: 'windows' }
      : action === 'wait'
        ? { duration: 1 }
        : action === 'verify'
          ? { window_id: 'hwnd:0x1', expect: [{ present: 'Saved' }] }
          : { window_id: 'hwnd:0x1' };
    const command = toComputerHostCommand({ action, input });
    const hostAction = String(command.action);
    assert.equal(
      isReplaySafeComputerCommand(command),
      true,
      `computer client treats ${action} (${hostAction}) as a mutation`,
    );
  }
});

test('computer observation variants are replay-safe but clipboard writes are not', () => {
  for (const args of [
    { action: 'list', input: { kind: 'windows' } },
    { action: 'list', input: { kind: 'apps' } },
    { action: 'capture', input: { window_id: 'hwnd:0x1', mode: 'state' } },
    {
      action: 'capture',
      input: { mode: 'zoom', frame_id: 'frame-1', region: [0, 0, 20, 20] },
    },
    { action: 'clipboard', input: { operation: 'read' } },
  ]) {
    assert.equal(
      isReplaySafeComputerCommand(toComputerHostCommand(args)),
      true,
      JSON.stringify(args),
    );
  }
  assert.equal(
    isReplaySafeComputerCommand(toComputerHostCommand({
      action: 'clipboard',
      input: { operation: 'write', text: 'not replay-safe' },
    })),
    false,
  );
});

test('computer runtime manifest stays in parity with host command handlers', async () => {
  // Handlers live in both halves of the host: the TypeScript decisions and the
  // PowerShell program they dispatch into.
  // The PowerShell half is split by capability, so every piece counts as host
  // source: a handler is present wherever its dispatch case lives.
  const hostSource = (await Promise.all([
    'computer-host-powershell.ts',
    'computer-host-program.ts',
    'computer-host-ps-session.ts',
    'computer-host-ps-observation.ts',
    'computer-host-ps-input.ts',
    'computer-host-ps-runtime.ts',
  ].map((name) => readFile(
    new URL(`../../apps/desktop/src/main/${name}`, import.meta.url),
    'utf8',
  )))).join('\n');
  // Every schema action, including the button/operation/kind variants that
  // select a different host command, so no mapped command can lose its handler.
  const calls = [
    { action: 'list', input: { kind: 'windows' } },
    { action: 'list', input: { kind: 'apps' } },
    { action: 'diagnose', input: { window_id: 'hwnd:0x1' } },
    { action: 'capture', input: { window_id: 'hwnd:0x1' } },
    { action: 'capture', input: { mode: 'zoom', frame_id: 'frame:1', region: [0, 0, 4, 4] } },
    { action: 'click', input: { window_id: 'hwnd:0x1', ref: 'ref:1' } },
    { action: 'click', input: { window_id: 'hwnd:0x1', element: 1, button: 'left' } },
    { action: 'click', input: { window_id: 'hwnd:0x1', element: 1, button: 'right' } },
    { action: 'click', input: { window_id: 'hwnd:0x1', element: 1, button: 'middle' } },
    { action: 'double_click', input: { window_id: 'hwnd:0x1', element: 1 } },
    { action: 'mouse_move', input: { window_id: 'hwnd:0x1', element: 1 } },
    { action: 'drag', input: { window_id: 'hwnd:0x1', ref: 'ref:1', to: 'ref:2' } },
    { action: 'type', input: { window_id: 'hwnd:0x1', text: 'value' } },
    { action: 'key', input: { window_id: 'hwnd:0x1', keys: '^s' } },
    { action: 'scroll', input: { window_id: 'hwnd:0x1', direction: 'down' } },
    { action: 'wait', input: { duration: 1 } },
    {
      action: 'sequence',
      input: {
        window_id: 'hwnd:0x1',
        steps: [
          { action: 'click', ref: 'ref:1' },
          { action: 'type', text: 'value' },
        ],
      },
    },
    {
      action: 'sequence',
      input: {
        window_id: 'hwnd:0x1',
        steps: [
          { action: 'click', element: 1, button: 'right' },
          { action: 'key', keys: '{ENTER}' },
        ],
      },
    },
    ...['focus', 'minimize', 'maximize', 'restore', 'close'].map((operation) => ({
      action: 'window',
      input: { window_id: 'hwnd:0x1', operation },
    })),
    { action: 'window', input: { window_id: 'hwnd:0x1', operation: 'move', x: 10 } },
    { action: 'clipboard', input: { operation: 'read' } },
    { action: 'clipboard', input: { operation: 'write', text: 'value' } },
    { action: 'launch', input: { app: 'notepad.exe' } },
    { action: 'type', input: { window_id: 'hwnd:0x1', ref: 'ref:1', text: 'value', mode: 'set' } },
    { action: 'menu', input: { window_id: 'hwnd:0x1', path: ['File', 'Save As'] } },
    { action: 'verify', input: { window_id: 'hwnd:0x1', expect: [{ present: 'Saved' }] } },
  ];
  const hostActions = new Set();
  for (const args of calls) {
    assert.equal(validateComputerToolArgs(args), null, JSON.stringify(args));
    const command = toComputerHostCommand(args);
    hostActions.add(String(command.action));
    for (const step of command.steps || []) hostActions.add(String(step.action));
  }
  // The TypeScript host answers some commands itself and forwards the rest to
  // the PowerShell dispatch switch, so a handler is either form.
  for (const action of hostActions) {
    const handled = hostSource.includes(`action === '${action}'`)
      || hostSource.includes(`case '${action}'`)
      || new RegExp(`'${action}'\\s*\\{`).test(hostSource);
    assert.equal(handled, true, `host handler missing for ${action}`);
  }
  // Observation is one action: the removed generation must stay unreachable.
  for (const removed of ['snapshot', 'find', 'screenshot', 'window_bounds']) {
    assert.equal(hostActions.has(removed), false, removed);
  }
});

test('computer window targets take one exact window_id or one app fallback', () => {
  assert.equal(validateComputerToolArgs({
    action: 'click',
    input: { app: 'Notepad', ref: 'ref:1' },
  }), null);
  assert.equal(validateComputerToolArgs({
    action: 'sequence',
    input: {
      app: 'Notepad',
      steps: [{ action: 'click', ref: 'ref:1' }, { action: 'type', text: 'value' }],
    },
  }), null);
  // Neither target, both targets, and an empty app are all refused up front.
  assert.match(
    validateComputerToolArgs({ action: 'click', input: { ref: 'ref:1' } }),
    /exactly one of window_id or app/,
  );
  assert.match(
    validateComputerToolArgs({
      action: 'type',
      input: { window_id: 'hwnd:0x1', app: 'Notepad', text: 'value' },
    }),
    /exactly one of window_id or app/,
  );
  assert.match(
    validateComputerToolArgs({ action: 'window', input: { app: '   ', operation: 'focus' } }),
    /app must not be empty/,
  );
  assert.match(
    validateComputerToolArgs({
      action: 'capture',
      input: { window_id: 'hwnd:0x1', app: 'Notepad' },
    }),
    /at most one of window_id, app, or screen/,
  );
  assert.match(
    validateComputerToolArgs({
      action: 'capture',
      input: { mode: 'zoom', frame_id: 'frame-1', region: [0, 0, 20, 20], screen: 0 },
    }),
    /instead of a window, app, or screen target/,
  );
  // The host resolves the label, so the app target travels through unchanged.
  assert.deepEqual(toComputerHostCommand({
    action: 'type',
    input: { app: 'Notepad', text: 'value' },
  }), { app: 'Notepad', text: 'value', action: 'type' });
});

test('computer tool contract exposes stable targets, frames, and explicit delivery', () => {
  const schema = COMPUTER_TOOL_DEFS[0].inputSchema;
  assert.deepEqual(Object.keys(schema.properties), ['action', 'input', 'capture_after']);
  assert.deepEqual(schema.required, ['action']);
  assert.ok(Array.isArray(schema.oneOf));
  const inputFor = (action) => schema.oneOf.find(
    (branch) => branch.properties.action.enum.includes(action),
  ).properties.input;
  const list = inputFor('list');
  const diagnose = inputFor('diagnose');
  const capture = inputFor('capture');
  const click = inputFor('click');
  const drag = inputFor('drag');
  const key = inputFor('key');
  const scroll = inputFor('scroll');
  const sequence = inputFor('sequence');
  const window = inputFor('window');
  const clipboard = inputFor('clipboard');
  assert.deepEqual(schema.properties.action.enum, [
    'list', 'diagnose', 'capture', 'verify',
    'click', 'double_click', 'mouse_move', 'drag', 'type', 'key', 'scroll', 'wait',
    'sequence', 'window', 'menu', 'clipboard', 'launch',
  ]);
  // verify waits on state without pixels; menu resolves an exact label path.
  assert.deepEqual(
    Object.keys(inputFor('verify').properties.expect.items.properties),
    ['present', 'absent', 'title_contains', 'window_exists'],
  );
  assert.equal(inputFor('verify').properties.expect.maxItems, 8);
  assert.equal(inputFor('verify').properties.stable_samples.maximum, 5);
  assert.equal(inputFor('menu').properties.path.maxItems, 8);
  assert.deepEqual(inputFor('type').properties.mode.enum, ['literal', 'set']);
  assert.deepEqual(list.properties.kind.enum, ['windows', 'apps']);
  assert.ok(diagnose.properties.ocr_language);
  assert.ok(capture.properties.window_id);
  assert.ok(click.properties.frame_id);
  assert.deepEqual(click.properties.button.enum, ['left', 'right', 'middle']);
  assert.deepEqual(click.properties.delivery.enum, ['background', 'foreground']);
  assert.ok(capture.properties.continuation);
  assert.ok(capture.properties.include_noninteractive);
  assert.deepEqual(capture.properties.mode.enum, ['state', 'som', 'vision', 'ax', 'zoom']);
  assert.ok(click.properties.element);
  assert.ok(drag.properties.to_element);
  assert.ok(drag.properties.to_x);
  assert.ok(drag.properties.to_y);
  assert.ok(key.properties.keys.description.includes('"^s"'));
  assert.ok(capture.properties.include_ocr);
  assert.equal(capture.properties.max_ocr_words.maximum, 1000);
  assert.deepEqual(scroll.properties.direction.enum, ['up', 'down', 'left', 'right']);
  assert.equal(sequence.properties.steps.minItems, 2);
  assert.equal(sequence.properties.steps.maxItems, 6);
  assert.deepEqual(window.properties.operation.enum, [
    'focus', 'move', 'minimize', 'maximize', 'restore', 'close',
  ]);
  assert.deepEqual(clipboard.properties.operation.enum, ['read', 'write']);
  assert.equal(schema.properties.capture_after.properties.delay_ms.maximum, 2000);
  assert.equal(schema.properties.capture_after.properties.max_elements.maximum, 1000);
  assert.equal(validateComputerToolArgs({ action: 'capture' }), null);
  assert.equal(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123', element: 2 },
  }), null);
  assert.match(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123' },
  }), /requires ref, element, or frame_id\/x\/y/i);
  assert.match(validateComputerToolArgs({
    action: 'capture',
    input: { text: 'wrong action' },
  }), /does not accept.*text/i);
  assert.match(validateComputerToolArgs({
    action: 'capture',
    input: { mode: 'state', screen: 1 },
  }), /screen requires mode="vision"/i);
  assert.match(validateComputerToolArgs({
    action: 'clipboard',
    input: { operation: 'write' },
  }), /requires.*text/i);
  assert.match(validateComputerToolArgs({
    action: 'wait',
    input: { duration: 1 },
    capture_after: {},
  }), /does not accept capture_after/i);
  assert.match(validateComputerToolArgs({
    action: 'wait',
    input: { duration: 1 },
    duration: 1,
  }), /does not accept root field/i);
  assert.match(validateComputerToolArgs({
    action: 'list',
    input: { kind: 'files' },
  }), /kind must be one of: windows, apps/i);
  assert.match(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1', button: 'primary' },
  }), /button must be one of: left, right, middle/i);
  assert.match(validateComputerToolArgs({
    action: 'key',
    input: {
      window_id: 'hwnd:0x123',
      element: 2,
      keys: '{ENTER}',
    },
  }), /does not accept input field.*element/i);
  assert.match(validateComputerToolArgs({
    action: 'key',
    input: { window_id: 'hwnd:0x123', keys: 'a'.repeat(513) },
  }), /keys accepts at most 512 characters/i);
  assert.match(validateComputerToolArgs({
    action: 'type',
    input: { window_id: 'hwnd:0x123', text: 'a'.repeat(30_001) },
  }), /text accepts at most 30000 characters/i);
  assert.match(validateComputerToolArgs({
    action: 'clipboard',
    input: { operation: 'write', text: 'a'.repeat(50_001) },
  }), /text accepts at most 50000 characters/i);
  assert.match(validateComputerToolArgs({
    action: 'window',
    input: { window_id: 'hwnd:0x123', operation: 'hide' },
  }), /operation must be one of/i);
  assert.match(validateComputerToolArgs({
    action: 'window',
    input: { window_id: 'hwnd:0x123', operation: 'move', width: 0 },
  }), /input\.width must be at least 1/i);
  assert.match(validateComputerToolArgs({
    action: 'verify',
    input: {
      window_id: 'hwnd:0x123',
      expect: [{ present: ' ' }],
    },
  }), /predicate 1 text must not be empty/i);
  assert.match(validateComputerToolArgs({
    action: 'verify',
    input: {
      window_id: 'hwnd:0x123',
      expect: [{ present: 123 }],
    },
  }), /predicate 1 text must be a string/i);
  assert.match(validateComputerToolArgs({
    action: 'verify',
    input: {
      window_id: 'hwnd:0x123',
      expect: [{ window_exists: 'false' }],
    },
  }), /predicate 1 window_exists must be a boolean/i);
  assert.match(validateComputerToolArgs({
    action: 'clipboard',
    input: { operation: 'delete' },
  }), /operation must be one of: read, write/i);
  assert.match(validateComputerToolArgs({
    action: 'capture',
    input: { mode: 'zoom', frame_id: 'frame:1', region: [1, 2, 3] },
  }), /region requires at least 4 items/i);
  assert.match(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
    capture_after: { mode: 'tree' },
  }), /capture_after.mode must be one of/i);
  assert.equal(validateComputerToolArgs({
    action: 'diagnose',
    input: { ocr_language: 'ko' },
  }), null);
  assert.equal(validateComputerToolArgs({
    action: 'sequence',
    input: {
      window_id: 'hwnd:0x123',
      steps: [
        { action: 'click', frame_id: 'frame:1', x: 10, y: 20 },
        { action: 'type', text: 'hello' },
        { action: 'key', keys: '{ENTER}' },
      ],
    },
  }), null);
  assert.match(validateComputerToolArgs({
    action: 'sequence',
    input: {
      window_id: 'hwnd:0x123',
      steps: [
        { action: 'click', ref: 'ref:1' },
        { action: 'click', ref: 'ref:2' },
      ],
    },
  }), /steps after the first must be type, key, or wait/i);
  assert.match(validateComputerToolArgs({
    action: 'sequence',
    input: {
      window_id: 'hwnd:0x123',
      steps: [
        { action: 'click', ref: 'ref:1' },
        { action: 'type', ref: 'ref:2', text: 'hello' },
      ],
    },
  }), /reuse focus and cannot carry a target/i);
  assert.match(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
    safety: {
      decision: 'confirm',
    },
  }), /does not accept root field/i);
  assert.match(validateComputerToolArgs({
    action: 'launch',
    input: {
      app: 'mshta.exe C:\\Temp\\fixture.hta',
    },
  }), /blocks shells, script hosts, and shortcut files/i);
  for (const app of [
    'wt.exe',
    'wsl.exe',
    'bash.exe',
    'C:\\Temp\\terminal.lnk',
    'C:\\Temp\\website.url',
    'C:\\Temp\\clickonce.appref-ms',
  ]) {
    assert.match(validateComputerToolArgs({
      action: 'launch',
      input: { app },
    }), /blocks shells, script hosts, and shortcut files/i);
  }
  assert.equal(validateComputerToolArgs({
    action: 'launch',
    input: { app: 'C:\\Program Files\\Example App\\example.exe' },
  }), null);
  assert.equal(validateComputerToolArgs({
    action: 'launch',
    input: { app: 'C:\\Project\\mixdog\\Office-Use-Optimization-Report-v2.pptx' },
  }), null);
  assert.equal(validateComputerToolArgs({
    action: 'launch',
    input: { app: 'https://example.com' },
  }), null);
  assert.equal(validateComputerToolArgs({
    action: 'launch',
    input: { app: 'https://example.com/bash/download.url?left=1&&right=2' },
  }), null);
  // A provider may serialize the nested argument as a JSON string or flatten it
  // onto the root; both resolve to the same command instead of being refused.
  assert.equal(validateComputerToolArgs({
    action: 'list',
    input: '{"kind":"windows"}',
  }), null);
  assert.deepEqual(toComputerHostCommand({
    action: 'list',
    input: '{"kind":"windows"}',
  }), { action: 'list_windows' });
  assert.equal(validateComputerToolArgs({ action: 'list', kind: 'windows' }), null);
  assert.deepEqual(
    toComputerHostCommand({ action: 'list', kind: 'windows' }),
    { action: 'list_windows' },
  );
  assert.equal(validateComputerToolArgs({
    action: 'click',
    input: '{"window_id":"hwnd:0x123","ref":"ref:1"}',
    capture_after: '{"mode":"ax"}',
  }), null);
  assert.deepEqual(toComputerHostCommand({
    action: 'click',
    input: '{"window_id":"hwnd:0x123","ref":"ref:1"}',
    capture_after: '{"mode":"ax"}',
  }), {
    window_id: 'hwnd:0x123',
    ref: 'ref:1',
    action: 'invoke',
    capture_after: true,
    capture_after_mode: 'ax',
  });
  assert.match(validateComputerToolArgs({
    action: 'click',
    window_id: 'hwnd:0x123',
  }), /requires ref, element, or frame_id\/x\/y/i);
  // A string that cannot be resolved stays a string and still fails.
  assert.match(validateComputerToolArgs({
    action: 'list',
    input: '{"kind":"windows"',
  }), /input must be an object/i);
  assert.match(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
    capture_after: '{"mode":"ax"',
  }), /capture_after must be an object/i);
  assert.deepEqual(toComputerHostCommand({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1', button: 'right' },
    capture_after: { mode: 'ax', include_ocr: false },
  }), {
    window_id: 'hwnd:0x123',
    ref: 'ref:1',
    action: 'right_click',
    capture_after: true,
    capture_after_mode: 'ax',
    capture_after_include_ocr: false,
  });
  assert.deepEqual(toComputerHostCommand({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1', button: 'left' },
  }), {
    window_id: 'hwnd:0x123',
    ref: 'ref:1',
    action: 'invoke',
  });
  assert.deepEqual(toComputerHostCommand({
    action: 'window',
    input: { window_id: 'hwnd:0x123', operation: 'minimize' },
  }), {
    window_id: 'hwnd:0x123',
    action: 'window_state',
    state: 'minimize',
  });
  assert.deepEqual(toComputerHostCommand({
    action: 'sequence',
    input: {
      window_id: 'hwnd:0x123',
      steps: [
        { action: 'click', ref: 'ref:1', button: 'left' },
        { action: 'type', text: 'value' },
      ],
    },
  }), {
    window_id: 'hwnd:0x123',
    steps: [
      { action: 'invoke', ref: 'ref:1' },
      { action: 'type', text: 'value' },
    ],
    action: 'sequence',
  });
  assert.deepEqual(toComputerHostCommand({
    action: 'list',
    input: { kind: 'apps' },
  }), { action: 'list_apps' });
  assert.deepEqual(toComputerHostCommand({
    action: 'menu',
    input: { window_id: 'hwnd:0x123', path: ['File', 'Save As'] },
  }), {
    window_id: 'hwnd:0x123',
    path: ['File', 'Save As'],
    action: 'invoke_menu',
  });
  assert.deepEqual(toComputerHostCommand({
    action: 'capture',
    input: { mode: 'zoom', frame_id: 'frame:1', region: [1, 2, 3, 4] },
  }), {
    frame_id: 'frame:1',
    region: [1, 2, 3, 4],
    action: 'zoom',
  });
  assert.deepEqual(toComputerHostCommand({
    action: 'clipboard',
    input: { operation: 'write', text: 'value' },
  }), {
    text: 'value',
    action: 'clipboard_write',
  });
  // A frame can be answered beside the run instead of inside the conversation,
  // but only where pixels exist at all.
  assert.equal(validateComputerToolArgs({
    action: 'capture',
    input: { window_id: 'hwnd:0x123', image_output: 'file' },
  }), null);
  assert.match(
    String(validateComputerToolArgs({
      action: 'capture',
      input: { window_id: 'hwnd:0x123', mode: 'ax', image_output: 'file' },
    })),
    /image_output requires a mode that returns pixels/,
  );
  assert.equal(
    toComputerHostCommand({
      action: 'click',
      input: { window_id: 'hwnd:0x123', element: 2 },
      capture_after: { image_output: 'file' },
    }).capture_after_image_output,
    'file',
  );
  assert.deepEqual([
    ['focus', 'focus_window'],
    ['move', 'move_window'],
    ['minimize', 'window_state'],
    ['maximize', 'window_state'],
    ['restore', 'window_state'],
    ['close', 'close_window'],
  ].map(([operation, expected]) => toComputerHostCommand({
    action: 'window',
    input: {
      window_id: 'hwnd:0x123',
      operation,
      ...(operation === 'move' ? { x: 10 } : {}),
    },
  }).action), [
    'focus_window', 'move_window', 'window_state',
    'window_state', 'window_state', 'close_window',
  ]);
  // 17 actions with one strict input shape each. The budget bounds what every
  // request pays for the tool definition, so it moves only with a new action.
  assert.ok(Buffer.byteLength(JSON.stringify(COMPUTER_TOOL_DEFS[0])) <= 18_000);
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('list targets first'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('instead of recapturing by default'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('pixel_unavailable'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('Browser Use'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('at most one computer call per model turn'));
});

test('bridge clients only surface fresh, compatible discovery records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-bridge-clients-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  try {
    for (const client of CLIENTS) {
      const path = join(directory, client.file);
      await writeFile(path, '{"version":1,"port":1234}\n');
      assert.equal(client.available(), false, `${client.name}: missing token`);

      await writeFile(path, '{"version":2,"port":1234,"token":"secret"}\n');
      assert.equal(client.available(), false, `${client.name}: incompatible version`);

      await writeFile(path, '{"version":1,"port":1234,"token":"secret"}\n');
      assert.equal(client.available(), true, `${client.name}: valid discovery`);

      const stale = new Date(Date.now() - 6 * 60_000);
      await utimes(path, stale, stale);
      assert.equal(client.available(), false, `${client.name}: stale discovery`);
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge clients authenticate and preserve text plus image results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-bridge-execute-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({
        authorization: request.headers.authorization,
        body,
      });
      const payload = JSON.stringify({
        ok: true,
        value: {
          text: request.headers.authorization === 'Bearer computer-token'
            ? body.action === 'clipboard_read'
              ? '{"action":"user-content","nested":true}'
              : JSON.stringify({ ok: true, action: body.action })
            : 'bridge ok',
          image: { mimeType: 'image/jpeg', data: 'aGVsbG8=' },
          ...(request.headers.authorization === 'Bearer browser-token'
            ? {
                file: {
                  mimeType: 'text/plain',
                  data: 'ZmlsZQ==',
                  name: 'download.txt',
                },
              }
            : {}),
        },
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (const client of CLIENTS) {
      await writeFile(join(directory, client.file), `${JSON.stringify({
        version: 1,
        port: address.port,
        token: `${client.name}-token`,
      })}\n`);
      const action = client.name === 'computer' ? 'click' : 'snapshot';
      const result = await client.execute(
        client.name === 'browser'
          ? { action, input: { tab: 'schema-test' } }
          : {
              action,
              input: { window_id: 'hwnd:0x123', ref: 'ref:1', button: 'left' },
            },
        client.name === 'computer'
          ? { sessionId: 'computer-session-1' }
          : { sessionId: 'browser-session-1', turnId: 7 },
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.content, [
        {
          type: 'text',
          text: client.name === 'computer'
            ? '{"ok":true,"action":"click","button":"left"}'
            : 'bridge ok',
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' },
        },
        ...(client.name === 'browser'
          ? [{
              type: 'file',
              data: 'ZmlsZQ==',
              mimeType: 'text/plain',
              filename: 'download.txt',
            }]
          : []),
      ]);
    }
    const clipboardRead = await executeComputerTool(
      { action: 'clipboard', input: { operation: 'read' } },
      { sessionId: 'computer-session-1' },
    );
    assert.equal(
      clipboardRead.content[0].text,
      '{"action":"user-content","nested":true}',
    );
    assert.equal(deferComputerSessionRelease('computer-session-1', 20), true);
    const continued = await executeComputerTool(
      { action: 'list', input: { kind: 'windows' } },
      { sessionId: 'computer-session-1' },
    );
    assert.equal(continued.isError, undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(seen.filter((entry) => entry.body.action === 'session_release').length, 0);
    assert.equal(deferComputerSessionRelease('computer-session-1', 20), true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(seen.filter((entry) => entry.body.action === 'session_release').length, 1);
    assert.equal(await releaseComputerSession('computer-session-1'), true);
    assert.equal(await releaseComputerSession('computer-session-1'), true);
    assert.deepEqual(seen, [...CLIENTS.map((client) => ({
      authorization: `Bearer ${client.name}-token`,
      body: {
        action: client.name === 'computer' ? 'click' : 'snapshot',
        ...(client.name === 'browser'
          ? { tab: 'schema-test', session_id: 'browser-session-1', turn_id: 7 }
          : {}),
        ...(client.name === 'computer'
          ? {
              window_id: 'hwnd:0x123',
              ref: 'ref:1',
              action: 'invoke',
              session_id: 'computer-session-1',
            }
          : {}),
      },
    })), {
      authorization: 'Bearer computer-token',
      body: {
        action: 'clipboard_read',
        session_id: 'computer-session-1',
      },
    }, {
      authorization: 'Bearer computer-token',
      body: {
        action: 'list_windows',
        session_id: 'computer-session-1',
      },
    }, {
      authorization: 'Bearer computer-token',
      body: {
        action: 'session_release',
        session_id: 'computer-session-1',
      },
    }, {
      authorization: 'Bearer computer-token',
      body: {
        action: 'session_release',
        session_id: 'computer-session-1',
      },
    }, {
      authorization: 'Bearer computer-token',
      body: {
        action: 'session_release',
        session_id: 'computer-session-1',
      },
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('computer client propagates caller cancellation to same-session host abort', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-abort-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const seen = [];
  let resolveCommandSeen;
  let resolveAbortSeen;
  const commandSeen = new Promise((resolve) => { resolveCommandSeen = resolve; });
  const abortSeen = new Promise((resolve) => { resolveAbortSeen = resolve; });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push(body);
      if (body.action === 'session_abort') {
        const payload = JSON.stringify({ ok: true, value: { text: 'aborted' } });
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
        response.end(payload);
        resolveAbortSeen();
        return;
      }
      resolveCommandSeen();
      request.once('close', () => {
        try { response.destroy(); } catch {}
      });
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify({
      version: 1,
      port: address.port,
      token: 'computer-token',
    })}\n`);
    const controller = new AbortController();
    const execution = executeComputerTool(
      { action: 'wait', input: { duration: 30 } },
      { sessionId: 'cancel-session', signal: controller.signal },
    );
    await commandSeen;
    controller.abort();
    const result = await execution;
    await abortSeen;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /computer command aborted; input state and session resources were released/);
    assert.deepEqual(seen, [
      { action: 'wait', duration: 30, session_id: 'cancel-session' },
      { action: 'session_abort', session_id: 'cancel-session' },
    ]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser bridge replacement retries observations but never replays mutations', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-browser-replacement-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  let oldRequests = 0;
  let replacementRequests = 0;
  const replacement = createServer((_request, response) => {
    replacementRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, value: { text: 'replacement observation' } }));
  });
  const old = createServer((_request, response) => {
    oldRequests += 1;
    void writeFile(join(directory, 'browser-bridge.json'), `${JSON.stringify({
      version: 1,
      port: replacement.address().port,
      token: 'replacement-token',
    })}\n`).then(() => {
      if (oldRequests === 1) {
        response.destroy();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '100',
      });
      response.write('{"ok":');
      setImmediate(() => response.destroy());
    });
  });
  try {
    await new Promise((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(0, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      old.once('error', reject);
      old.listen(0, '127.0.0.1', resolve);
    });
    const pointDiscoveryAtOld = async () => {
      await writeFile(join(directory, 'browser-bridge.json'), `${JSON.stringify({
        version: 1,
        port: old.address().port,
        token: 'old-token',
      })}\n`);
    };

    await pointDiscoveryAtOld();
    const mutation = await executeBrowserTool({
      action: 'click',
      input: { ref: 'p1-s1-e1' },
    });
    assert.equal(mutation.isError, true);
    assert.match(mutation.content[0].text, /may have executed and was not replayed/);
    assert.equal(oldRequests, 1);
    assert.equal(replacementRequests, 0);

    await pointDiscoveryAtOld();
    const observation = await executeBrowserTool({
      action: 'snapshot',
      input: { tab: 'p1' },
    });
    assert.equal(observation.isError, undefined);
    assert.equal(observation.content[0].text, 'replacement observation');
    assert.equal(oldRequests, 2);
    assert.equal(replacementRequests, 1);
  } finally {
    old.closeAllConnections?.();
    replacement.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => old.close(resolve)),
      new Promise((resolve) => replacement.close(resolve)),
    ]);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser client rejects oversized commands before dispatch', async () => {
  const result = await executeBrowserTool({
    action: 'fill',
    input: {
      fields: Array.from({ length: 30 }, (_value, index) => ({
        ref: `p1-s1-e${index + 1}`,
        text: 'x'.repeat(10_000),
      })),
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exceeds 262144 bytes/);
});

test('browser client propagates caller cancellation and budget identity', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-browser-abort-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  let seen;
  let resolveCommandSeen;
  let resolveDisconnected;
  const commandSeen = new Promise((resolve) => { resolveCommandSeen = resolve; });
  const disconnected = new Promise((resolve) => { resolveDisconnected = resolve; });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      resolveCommandSeen();
      response.once('close', resolveDisconnected);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(join(directory, 'browser-bridge.json'), `${JSON.stringify({
      version: 1,
      port: address.port,
      token: 'browser-token',
    })}\n`);
    const controller = new AbortController();
    const execution = executeBrowserTool(
      { action: 'wait', text: 'never' },
      {
        sessionId: 'browser-cancel-session',
        turnId: 9,
        signal: controller.signal,
      },
    );
    await commandSeen;
    controller.abort();
    const result = await execution;
    await disconnected;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /browser command cancelled/);
    assert.deepEqual(seen, {
      action: 'wait',
      text: 'never',
      session_id: 'browser-cancel-session',
      turn_id: 9,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('computer client retries once against a republished bridge endpoint', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-retry-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const seen = [];
  let staleRequestSeen = () => {};
  let staleReleased = Promise.resolve();
  let releaseStale = () => {};
  const armStaleEndpoint = () => {
    const staleHit = new Promise((resolve) => { staleRequestSeen = resolve; });
    staleReleased = new Promise((resolve) => { releaseStale = resolve; });
    return staleHit;
  };
  // The endpoint discovery still points at: it accepts the connection and drops
  // it, exactly like a bridge whose app restarted mid-flight. The drop waits for
  // the republished discovery so the retry has a live endpoint to find.
  const staleServer = createServer((request) => {
    staleRequestSeen();
    void staleReleased.then(() => request.destroy());
  });
  const liveServer = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const payload = JSON.stringify({ ok: true, value: { text: 'ok' } });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  const discoveryFile = join(directory, 'computer-bridge.json');
  const publish = async (port, token) => {
    await writeFile(discoveryFile, `${JSON.stringify({ version: 1, port, token })}\n`);
  };
  const unauthorizedServer = createServer((_request, response) => {
    void publish(liveServer.address().port, 'live-token').then(() => {
      const payload = JSON.stringify({ ok: false, error: 'unauthorized' });
      response.writeHead(401, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  try {
    for (const server of [staleServer, liveServer, unauthorizedServer]) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    let staleHit = armStaleEndpoint();
    await publish(staleServer.address().port, 'stale-token');
    const sameEndpointMutationExecution = executeComputerTool(
      {
        action: 'click',
        input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
      },
      { sessionId: 'retry-session' },
    );
    await staleHit;
    releaseStale();
    const sameEndpointMutation = await sameEndpointMutationExecution;
    assert.equal(sameEndpointMutation.isError, true);
    assert.match(sameEndpointMutation.content[0].text, /may have executed and was not replayed/);
    assert.deepEqual(seen, []);

    staleHit = armStaleEndpoint();
    await publish(staleServer.address().port, 'stale-token');
    const mutationExecution = executeComputerTool(
      {
        action: 'click',
        input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
      },
      { sessionId: 'retry-session' },
    );
    await staleHit;
    await publish(liveServer.address().port, 'live-token');
    releaseStale();
    const mutation = await mutationExecution;
    assert.equal(mutation.isError, true);
    assert.match(mutation.content[0].text, /may have executed and was not replayed/);
    assert.deepEqual(seen, []);

    staleHit = armStaleEndpoint();
    await publish(staleServer.address().port, 'stale-token');
    const execution = executeComputerTool(
      { action: 'list', input: { kind: 'windows' } },
      { sessionId: 'retry-session' },
    );
    await staleHit;
    await publish(liveServer.address().port, 'live-token');
    releaseStale();
    const result = await execution;
    assert.equal(result.isError, undefined);
    assert.deepEqual(seen, [{ action: 'list_windows', session_id: 'retry-session' }]);

    await publish(unauthorizedServer.address().port, 'stale-token');
    const authResult = await executeComputerTool(
      { action: 'list', input: { kind: 'apps' } },
      { sessionId: 'retry-session' },
    );
    assert.equal(authResult.isError, undefined);
    assert.deepEqual(seen, [
      { action: 'list_windows', session_id: 'retry-session' },
      { action: 'list_apps', session_id: 'retry-session' },
    ]);
  } finally {
    for (const server of [staleServer, liveServer, unauthorizedServer]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await releaseAllComputerSessions(1_000);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('computer client releases every host-bound session on shutdown', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-shutdown-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const payload = JSON.stringify({ ok: true, value: { text: 'ok' } });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify({
      version: 1,
      port: address.port,
      token: 'computer-token',
    })}\n`);
    // A read-only observation still owns a host worker, so shutdown must
    // release it even though it never entered the write-active set.
    await executeComputerTool(
      { action: 'list', input: { kind: 'windows' } },
      { sessionId: 'shutdown-read-session' },
    );
    await executeComputerTool(
      { action: 'click', input: { window_id: 'hwnd:0x123', ref: 'ref:1' } },
      { sessionId: 'shutdown-write-session' },
    );
    // The deferred timer is unref'd and would never fire on the exit path.
    assert.equal(deferComputerSessionRelease('shutdown-write-session', 60_000), true);
    assert.ok(await releaseAllComputerSessions(2_000) >= 2);
    const released = seen
      .filter((body) => body.action === 'session_release')
      .map((body) => body.session_id);
    assert.ok(released.includes('shutdown-read-session'));
    assert.ok(released.includes('shutdown-write-session'));
    // Idempotent: a second shutdown pass has nothing left to release.
    assert.equal(await releaseAllComputerSessions(2_000), 0);
    assert.equal(
      seen.filter((body) => body.action === 'session_release').length,
      released.length,
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});
