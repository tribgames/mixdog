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
  validateBrowserToolArgs,
} from './browser-bridge/action-schema.mjs';
import { TOOL_DEFS as BROWSER_TOOL_DEFS } from './browser-bridge/tool-defs.mjs';
import {
  computerBridgeAvailableSync,
  executeComputerTool,
  releaseComputerSession,
} from './computer-bridge/client.mjs';
import {
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
  assert.ok(Buffer.byteLength(JSON.stringify(BROWSER_TOOL_DEFS[0])) <= 12_000);
  assert.deepEqual(propertyFor('fill', 'fields').items.required, ['ref']);
  assert.equal(propertyFor('fill', 'fields').items.additionalProperties, false);
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
  assert.equal(schema.properties.action.enum.length, 30);
  assert.ok(propertyFor('click', 'ref').description.includes('p1-s3-e12'));
  assert.ok(propertyFor('click', 'snapshotId'));
  assert.deepEqual(propertyFor('snapshot', 'mode').enum, ['semantic', 'visual', 'both']);
  assert.deepEqual(propertyFor('click', 'pointer').enum, ['mouse', 'touch']);
  assert.deepEqual(propertyFor('click', 'button').enum, ['left', 'right', 'middle']);
  assert.deepEqual(propertyFor('click', 'modifiers').items.enum, ['Alt', 'Control', 'Meta', 'Shift']);
  assert.deepEqual(propertyFor('snapshot', 'format').enum, ['jpeg', 'png']);
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
  assert.equal(propertyFor('snapshot', 'maxElements').maximum, 500);
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
    input: { url: 'https://example.com', includeScreenshot: true },
  }), {
    ok: true,
    action: 'navigate',
    input: { url: 'https://example.com', includeScreenshot: true },
  });
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

test('browser runtime manifest stays in parity with host command handlers', async () => {
  const hostSource = await readFile(
    new URL('../../apps/desktop/src/main/browser-host.ts', import.meta.url),
    'utf8',
  );
  for (const action of BROWSER_ACTIONS) {
    const handled = hostSource.includes(`case '${action}'`)
      || hostSource.includes(`action === '${action}'`);
    assert.equal(handled, true, `host handler missing for ${action}`);
  }
  for (const removed of [
    'observe', 'screenshot', 'click_at', 'tap', 'hover_at', 'drag_at', 'swipe', 'fill_form',
  ]) {
    assert.equal(hostSource.includes(`case '${removed}'`), false, removed);
    assert.equal(hostSource.includes(`action === '${removed}'`), false, removed);
  }
});

test('computer tool contract exposes stable targets, frames, and explicit delivery', () => {
  const schema = COMPUTER_TOOL_DEFS[0].inputSchema;
  assert.deepEqual(Object.keys(schema.properties), ['action', 'input', 'capture_after', 'safety']);
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
    'list', 'diagnose', 'capture',
    'click', 'double_click', 'mouse_move', 'drag', 'type', 'key', 'scroll', 'wait',
    'sequence', 'window', 'clipboard', 'launch',
  ]);
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
      ref: 'ref:1',
      element: 2,
      keys: '{ENTER}',
    },
  }), /only one of ref or element/i);
  assert.match(validateComputerToolArgs({
    action: 'window',
    input: { window_id: 'hwnd:0x123', operation: 'hide' },
  }), /operation must be one of/i);
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
  assert.equal(validateComputerToolArgs({
    action: 'click',
    input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
    safety: {
      decision: 'require_confirmation',
      category: 'communication',
      explanation: 'This click sends a message.',
    },
  }), null);
  assert.match(validateComputerToolArgs({
    action: 'capture',
    safety: {
      decision: 'require_confirmation',
      category: 'other',
      explanation: 'not a mutation',
    },
  }), /does not accept safety/i);
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
  assert.ok(Buffer.byteLength(JSON.stringify(COMPUTER_TOOL_DEFS[0])) <= 16_000);
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('list targets first'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('instead of recapturing by default'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('pixel_unavailable'));
  assert.ok(COMPUTER_TOOL_DEFS[0].description.includes('Browser Use'));
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
  const approvals = [];
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
            ? JSON.stringify({ ok: true, action: body.action })
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
              safety: {
                decision: 'require_confirmation',
                category: 'communication',
                explanation: 'This test click represents a send action.',
              },
            },
        client.name === 'computer'
          ? {
              sessionId: 'computer-session-1',
              requestApproval: async (request) => {
                approvals.push(request);
                return { approved: true };
              },
            }
          : { sessionId: 'browser-session-1', turnId: 7 },
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.content, [
        {
          type: 'text',
          text: client.name === 'computer'
            ? '{"ok":true,"action":"click","button":"left","safety_acknowledgement":{"decision":"confirmed","category":"communication","explanation":"This test click represents a send action."}}'
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
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].reason, 'This test click represents a send action.');
    const deniedWithoutUi = await executeComputerTool({
      action: 'click',
      input: { window_id: 'hwnd:0x123', ref: 'ref:1' },
      safety: {
        decision: 'require_confirmation',
        category: 'communication',
        explanation: 'Approval UI must exist before dispatch.',
      },
    }, { sessionId: 'computer-session-1' });
    assert.equal(deniedWithoutUi.isError, true);
    assert.match(deniedWithoutUi.content[0].text, /no approval UI is available/i);
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
    assert.match(result.content[0].text, /computer command aborted; input state and desktop lease were released/);
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
