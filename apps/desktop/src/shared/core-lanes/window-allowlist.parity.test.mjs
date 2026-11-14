// Window scope parity: a window-scoped connection may call every protocol method except the host-role ones listed in
// the core's window_methods.json. Every method the renderer can produce through the shared lanes (the static route
// tables, every capability, the direct API) must be one the core lets a window call, or the window would lose a feature
// it had through the desktop main process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { ACTION_NAMESPACES } from '../../../../../packages/protocol-client/src/actions/action-namespaces.mjs';
import { METHOD_ARGS } from '../../../../../packages/protocol-client/src/actions/method-args.generated.mjs';
import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../contract-capabilities.ts';
import { DIRECT_KEYS } from '../desktop-api-split.ts';
import { routeCapability } from './capability-route.ts';
import {
  NOTIFICATION_DESKTOP_OPERATIONS,
  ROUTED_DESKTOP_OPERATIONS,
  routeDesktopNotification,
  routeDesktopOperation,
} from './desktop-operation-route.ts';
import { isSectionCapability } from '../section-capabilities.ts';
import { LOGIN_CANCEL_METHODS, LOGIN_START_METHODS } from './login-feed.ts';
import { routeService } from './service-route.ts';

const WINDOW_METHODS = new URL(
  '../../../../../native/core/crates/mixdog-app-protocol/src/boundary/window_methods.json',
  import.meta.url
);
const table = JSON.parse(fs.readFileSync(fileURLToPath(WINDOW_METHODS), 'utf8'));
const REFUSED = new Set(table.methods);

/** The capabilities that give no request: the pushed sections and the activity notification. */
const NO_REQUEST_CAPABILITIES = [
  'getOnboardingStatus',
  'getProviderAccounts',
  'getProviderSetup',
  'getWebSearchRoute',
  'listAgents',
  'listPresets',
  'listProviders',
  'listWorkflows',
  'noteUserInput',
];

/** Argument lists that reach the branches of a router: none, an object, strings, and the action shapes the goal call takes. */
const PROBES = [
  [],
  [{}],
  ['s'],
  ['s', 'r'],
  [{}, {}],
  [{ action: 'set' }],
  [{ action: 'clear' }],
  [{ action: 'status' }],
  [true],
  [1],
  ['s', {}],
  [['a']],
];

/** Every `{method}` a router gives for `name` over the probes; a probe the router refuses gives nothing. */
function methodsOf(route) {
  const found = new Set();
  for (const args of PROBES) {
    let routed;
    try {
      routed = route(args);
    } catch {
      continue;
    }
    for (const request of routed?.requests ?? [routed]) if (typeof request?.method === 'string') found.add(request.method);
  }
  return found;
}

function collect() {
  const bySource = new Map();
  const add = (source, methods) => {
    for (const method of methods) {
      if (!bySource.has(method)) bySource.set(method, new Set());
      bySource.get(method).add(source);
    }
  };
  for (const capability of new Set([...DESKTOP_CAPABILITIES, ...DESKTOP_READ_CAPABILITIES])) {
    add(`capability ${capability}`, methodsOf((args) => routeCapability(capability, args, 'sess')));
    add(`capability ${capability} (control session)`, methodsOf((args) => routeCapability(capability, args)));
  }
  // An operation the main process names itself (the host role's `localService.invokeDesktopOperation`, the remote shim) is
  // not a window's call: a window names an operation only in the renderer's direct API.
  const named = namesInDirectApi();
  for (const name of ROUTED_DESKTOP_OPERATIONS.filter((operation) => named.has(operation))) {
    add(`operation ${name}`, methodsOf((args) => routeDesktopOperation(name, args)));
  }
  for (const name of NOTIFICATION_DESKTOP_OPERATIONS.filter((operation) => named.has(operation))) {
    add(`notification ${name}`, methodsOf((args) => routeDesktopNotification(name, args)));
  }
  for (const name of serviceNames()) add(`service ${name}`, methodsOf((args) => routeService(name, args)));
  add('login feed start', LOGIN_START_METHODS);
  add('login feed cancel', LOGIN_CANCEL_METHODS);
  // The room actions are one service method with an action argument.
  for (const action of ['create', 'update', 'continue', 'leave', 'remove', 'reset']) {
    add(`service agentRoomAction(${action})`, methodsOf((args) => routeService('agentRoomAction', [action, args])));
  }
  return bySource;
}

/** Every quoted word in the renderer's direct API (`renderer/core-direct`, tests left out): the operations a window can name. */
function namesInDirectApi() {
  const directory = fileURLToPath(new URL('../../renderer/core-direct/', import.meta.url));
  const names = new Set();
  for (const file of fs.readdirSync(directory).filter((name) => /\.tsx?$/.test(name))) {
    for (const [, word] of fs.readFileSync(`${directory}${file}`, 'utf8').matchAll(/'([A-Za-z]+)'/g)) names.add(word);
  }
  return names;
}

/** The names of the service table (`SINGLE` of service-route.ts) and every direct key, which may name a service method. */
function serviceNames() {
  const path = fileURLToPath(new URL('./service-route.ts', import.meta.url));
  const file = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
  const names = new Set(Object.values(DIRECT_KEYS).flat());
  file.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (declaration.name.getText() !== 'SINGLE' || !declaration.initializer) continue;
      const object = declaration.initializer;
      if (ts.isObjectLiteralExpression(object)) {
        for (const property of object.properties) if (property.name) names.add(property.name.getText().replace(/['"]/g, ''));
      }
    }
  });
  return names;
}

test('the refusal list is a table of host-role methods only', () => {
  assert.equal(table.version, 2);
  assert.ok(table.methods.length > 0);
  assert.equal(new Set(table.methods).size, table.methods.length, 'a method is listed twice');
  const sorted = [...table.methods].sort();
  assert.deepEqual(table.methods, sorted, 'the list is kept sorted');
});

test('no method the shared lanes produce is one a window is refused', () => {
  const produced = collect();
  assert.ok(produced.size > 300, `only ${produced.size} methods enumerated: the enumeration is broken`);
  const refused = [...produced].filter(([method]) => REFUSED.has(method)).map(([method, sources]) => `${method} <- ${[...sources].slice(0, 3).join(', ')}`);
  assert.deepEqual(refused, []);
});

test('every capability resolves, and none to a host-role method', () => {
  const unresolved = [];
  for (const capability of DESKTOP_CAPABILITIES) {
    const methods = methodsOf((args) => routeCapability(capability, args, 'sess'));
    if (methods.size === 0) unresolved.push(capability);
    for (const method of methods) assert.ok(!REFUSED.has(method), `${capability} resolves to ${method}`);
  }
  // The capabilities that resolve to no request are a named list: the sections the core pushes (the connection's section
  // store answers them: section-capabilities.ts) and `noteUserInput`, which is the `client/activity` notification. A tenth
  // one, or one of these that starts resolving, is a change to look at.
  assert.deepEqual(unresolved.sort(), [...NO_REQUEST_CAPABILITIES].sort());
  for (const capability of unresolved) {
    assert.ok(capability === 'noteUserInput' || isSectionCapability(capability), `${capability} resolves to nothing and is neither a section nor the activity notification`);
  }
});

test('the protocol client actions and their argument table name no refused method', () => {
  const methods = new Set(Object.keys(METHOD_ARGS));
  for (const [namespace, actions] of Object.entries(ACTION_NAMESPACES)) for (const action of actions) methods.add(`${namespace}/${action}`);
  assert.deepEqual([...methods].filter((method) => REFUSED.has(method)), []);
});
