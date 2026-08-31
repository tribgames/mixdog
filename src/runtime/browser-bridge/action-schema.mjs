import { splitBridgeToolArgs } from '../shared/bridge-tool-args.mjs';
import {
  BROWSER_ACTIONS,
  BROWSER_OBSERVATION_ACTIONS,
  BROWSER_SEQUENCE_STEP_ACTIONS,
} from './browser-action-contract.mjs';

/** Actions that only observe the page. Naming them on the tool surface lets a
 *  caller repeat or overlap them without wondering whether they change state;
 *  the host enforces the same list when it decides what may run concurrently. */
export { BROWSER_ACTIONS, BROWSER_OBSERVATION_ACTIONS };

const PAGE_TARGET = ['tab', 'background'];
const SNAPSHOT_FILTERS = ['query', 'viewportOnly', 'maxElements', 'maxChars'];
const SCREENSHOT_OPTIONS = ['fullPage', 'format', 'quality', 'image_output'];
const POST_ACTION = ['expect', 'settleMs'];
const POST_ACTION_SNAPSHOT = [
  ...PAGE_TARGET, ...SNAPSHOT_FILTERS, 'includeScreenshot', ...SCREENSHOT_OPTIONS, ...POST_ACTION,
];

function contract(actions, fields = [], required = []) {
  const requiredAny = required.length && Array.isArray(required[0])
    ? required
    : (required.length ? [required] : []);
  return {
    actions: Array.isArray(actions) ? actions : [actions],
    fields,
    requiredAny,
  };
}

const CONTRACT_ROWS = [
  contract('navigate', ['url', 'reload', ...POST_ACTION_SNAPSHOT], [['url'], ['reload']]),
  contract('snapshot', [...PAGE_TARGET, ...SNAPSHOT_FILTERS, 'mode', ...SCREENSHOT_OPTIONS]),
  contract('locate', [...PAGE_TARGET, 'query', 'limit'], ['query']),
  contract('evaluate', [...POST_ACTION_SNAPSHOT, 'script', 'ref', 'timeoutMs', 'maxChars'], ['script']),
  contract('emulate', [
    ...POST_ACTION_SNAPSHOT,
    'width', 'height', 'deviceScaleFactor', 'mobile', 'touch', 'userAgent',
    'locale', 'timezone', 'colorScheme', 'reducedMotion', 'networkProfile',
    'cpuThrottlingRate', 'orientation', 'latitude', 'longitude', 'accuracy',
    'headers', 'reset',
  ]),
  contract('cookies', [
    ...PAGE_TARGET, 'operation', 'url', 'name', 'value', 'domain', 'path',
    'secure', 'httpOnly', 'sameSite', 'expirationDate',
  ]),
  contract('storage', [...PAGE_TARGET, 'operation', 'storageType', 'name', 'value']),
  contract('performance', [...PAGE_TARGET, 'operation', 'reload']),
  contract(
    'click',
    [
      ...POST_ACTION_SNAPSHOT, 'ref', 'snapshotId', 'x', 'y', 'pointer',
      'button', 'modifiers', 'doubleClick',
    ],
    [['ref'], ['snapshotId', 'x', 'y']],
  ),
  contract(
    'fill',
    [...POST_ACTION_SNAPSHOT, 'ref', 'text', 'fields', 'submit'],
    [['ref', 'text'], ['fields']],
  ),
  contract('type', [...POST_ACTION_SNAPSHOT, 'ref', 'text', 'submit'], ['ref', 'text']),
  // Without values, select reads the control's options instead of choosing.
  contract('select', [...POST_ACTION_SNAPSHOT, 'ref', 'values'], ['ref']),
  contract('check', [...POST_ACTION_SNAPSHOT, 'ref', 'checked'], ['ref']),
  contract(
    'hover',
    [...POST_ACTION_SNAPSHOT, 'ref', 'snapshotId', 'x', 'y'],
    [['ref'], ['snapshotId', 'x', 'y']],
  ),
  contract(
    'drag',
    [
      ...POST_ACTION_SNAPSHOT, 'ref', 'targetRef', 'snapshotId', 'x', 'y',
      'targetX', 'targetY', 'pointer',
    ],
    [['ref', 'targetRef'], ['snapshotId', 'x', 'y', 'targetX', 'targetY']],
  ),
  contract('upload', [...POST_ACTION_SNAPSHOT, 'ref', 'paths', 'confirm'], ['ref', 'paths', 'confirm']),
  contract('handle_dialog', [...POST_ACTION_SNAPSHOT, 'accept', 'promptText']),
  contract('press', [...POST_ACTION_SNAPSHOT, 'key'], ['key']),
  // text brings the first match into view when its position is unknown.
  contract('scroll', [
    ...POST_ACTION_SNAPSHOT, 'ref', 'snapshotId', 'x', 'y', 'dx', 'dy', 'text',
  ]),
  contract(['back', 'forward'], POST_ACTION_SNAPSHOT),
  // One call, several gestures on the SAME page. Steps address elements by ref
  // only: coordinates are bound to a snapshot the earlier steps invalidate.
  contract('sequence', [...POST_ACTION_SNAPSHOT, 'steps'], ['steps']),
  contract('read', [...PAGE_TARGET, 'query', 'maxChars', 'offset']),
  contract('extract', [...PAGE_TARGET, 'selector', 'attributes', 'limit', 'maxChars'], ['selector']),
  contract('wait', [...PAGE_TARGET, ...SNAPSHOT_FILTERS, 'text', 'textGone', 'url', 'timeoutMs']),
  contract('status', PAGE_TARGET),
  contract('console', [...PAGE_TARGET, 'level', 'query', 'limit']),
  contract('network', [
    ...PAGE_TARGET, 'requestId', 'resourceTypes', 'limit', 'frameLimit', 'maxChars', 'query',
  ]),
  // A rule outlives the call and answers every later request on the page, so
  // interception is page state rather than an observation.
  contract('intercept', [
    ...PAGE_TARGET, 'operation', 'url', 'resourceTypes', 'abort', 'body', 'ruleId',
  ]),
  // Runs before the document exists, which is the one moment evaluate can
  // never reach: by the time a page can be evaluated it has already booted.
  contract('init_script', [...PAGE_TARGET, 'operation', 'script', 'scriptId']),
  contract('list_tabs'),
  contract('close_tab', ['tab'], ['tab']),
  contract('downloads', ['downloadId', 'wait', 'attach', 'timeoutMs']),
  contract('open', PAGE_TARGET),
];

/** Steps a sequence may run. Everything here is deterministic on one page;
 *  navigation, uploads, and dialogs stay single calls so their fresh snapshot
 *  is always inspected before the next decision. */
const SEQUENCE_STEP_FIELDS = Object.freeze({
  click: ['ref'],
  fill: ['ref', 'text', 'submit'],
  type: ['ref', 'text', 'submit'],
  select: ['ref', 'values'],
  check: ['ref', 'checked'],
  hover: ['ref'],
  press: ['key'],
  scroll: ['ref', 'dx', 'dy'],
  wait: ['text', 'textGone', 'url', 'timeoutMs'],
});
const SEQUENCE_STEP_REQUIRED = Object.freeze({
  click: [['ref']],
  fill: [['ref', 'text']],
  type: [['ref', 'text']],
  select: [['ref', 'values']],
  check: [['ref']],
  hover: [['ref']],
  press: [['key']],
  scroll: [],
  wait: [['text'], ['textGone'], ['url']],
});
export const SEQUENCE_STEP_ACTIONS = BROWSER_SEQUENCE_STEP_ACTIONS;

function validateSequenceSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 6) {
    return 'browser action "sequence" input.steps requires 2 to 6 steps';
  }
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const at = `browser action "sequence" input.steps[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) return `${at} must be an object`;
    const stepAction = String(step.action || '').trim();
    const allowed = SEQUENCE_STEP_FIELDS[stepAction];
    if (!allowed) {
      return `${at} action must be one of ${SEQUENCE_STEP_ACTIONS.join(', ')}`;
    }
    const unsupported = Object.keys(step)
      .filter((name) => name !== 'action' && !allowed.includes(name));
    if (unsupported.length) {
      return `${at} does not accept field(s): ${unsupported.join(', ')}`;
    }
    const present = (name) => Object.hasOwn(step, name)
      && step[name] !== undefined && step[name] !== null;
    const requirements = SEQUENCE_STEP_REQUIRED[stepAction];
    if (requirements.length && !requirements.some((names) => names.every(present))) {
      return `${at} requires ${requirements.map((names) => names.join('+')).join(' or ')}`;
    }
    if (stepAction === 'select'
      && (!Array.isArray(step.values) || !step.values.length
        || step.values.length > 100
        || !step.values.every((value) => typeof value === 'string'))) {
      return `${at} values must be a non-empty array of strings`;
    }
    for (const [name, limit] of [
      ['ref', 128],
      ['text', 100_000],
      ['textGone', 10_000],
      ['url', 8_192],
      ['key', 100],
    ]) {
      if (Object.hasOwn(step, name)
        && (typeof step[name] !== 'string' || step[name].length > limit)) {
        return `${at}.${name} must be a string of at most ${limit} characters`;
      }
    }
    if (Array.isArray(step.values)
      && step.values.some((value) => value.length > 4_096)) {
      return `${at}.values entries are limited to 4096 characters`;
    }
  }
  return '';
}

const CONTRACT_ACTIONS = CONTRACT_ROWS.flatMap(({ actions }) => actions);
if (
  CONTRACT_ACTIONS.length !== BROWSER_ACTIONS.length
  || CONTRACT_ACTIONS.some((action, index) => action !== BROWSER_ACTIONS[index])
) {
  throw new Error('Browser action field contracts are out of sync with the shared action manifest.');
}
const CONTRACT_BY_ACTION = new Map(
  CONTRACT_ROWS.flatMap((row) => row.actions.map((action) => [action, row])),
);
const REQUIRED_SUMMARY = CONTRACT_ROWS
  .filter(({ requiredAny }) => requiredAny.length)
  .map(({ actions, requiredAny }) => (
    `${actions.join('/')} ${requiredAny.map((names) => names.join('+')).join(' or ')}`
  ))
  .join('; ');

export function buildBrowserInputSchema(flatSchema) {
  const properties = flatSchema?.properties || {};
  const { action, ...inputProperties } = properties;
  return {
    type: 'object',
    description: 'Choose one Browser Use action and pass only its fields in input.',
    properties: {
      action: { ...action, enum: BROWSER_ACTIONS },
      input: {
        type: 'object',
        description: `Fields for the selected action. Required: ${REQUIRED_SUMMARY}. Omit input when no fields are needed.`,
        properties: inputProperties,
      },
    },
    required: ['action'],
  };
}

export function validateBrowserToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'browser arguments must be an object' };
  }
  const action = String(args.action || '').trim();
  const actionContract = CONTRACT_BY_ACTION.get(action);
  if (!actionContract) {
    return { ok: false, error: `unknown browser action "${action || '(empty)'}"` };
  }

  const { hasNestedInput, input: rawInput, strayRootFields } = splitBridgeToolArgs(args);
  let input;
  if (hasNestedInput) {
    if (rawInput == null) input = {};
    else if (typeof rawInput === 'object' && !Array.isArray(rawInput)) input = { ...rawInput };
    else return { ok: false, error: `browser action "${action}" input must be an object` };
    if (strayRootFields.length) {
      return {
        ok: false,
        error: `browser action "${action}" fields must be inside input: ${strayRootFields.join(', ')}`,
      };
    }
  } else {
    input = rawInput;
  }

  const allowed = new Set(actionContract.fields);
  const unsupported = Object.keys(input).filter((name) => !allowed.has(name));
  if (unsupported.length) {
    return {
      ok: false,
      error: `browser action "${action}" does not accept input field(s): ${unsupported.join(', ')}`,
    };
  }
  const stringLimits = {
    url: 8_192,
    ref: 128,
    targetRef: 128,
    snapshotId: 128,
    tab: 64,
    query: 4_096,
    selector: 4_096,
    script: action === 'init_script' ? 20_000 : 100_000,
    text: 100_000,
    textGone: 10_000,
    key: 100,
    promptText: 10_000,
    name: 4_096,
    value: 100_000,
    domain: 4_096,
    path: 4_096,
    userAgent: 2_048,
    locale: 100,
    timezone: 100,
    body: 65_536,
    operation: 32,
    requestId: 100,
    ruleId: 100,
    scriptId: 100,
    downloadId: 100,
  };
  for (const [name, limit] of Object.entries(stringLimits)) {
    if (!Object.hasOwn(input, name)) continue;
    if (typeof input[name] !== 'string' || input[name].length > limit) {
      return {
        ok: false,
        error: `browser action "${action}" input.${name} must be a string of at most ${limit} characters`,
      };
    }
  }
  const boundedStringArray = (name, limit, itemLimit) => {
    if (!Object.hasOwn(input, name)) return '';
    const values = input[name];
    if (!Array.isArray(values) || values.length > limit
      || !values.every((value) => typeof value === 'string' && value.length <= itemLimit)) {
      return `browser action "${action}" input.${name} requires at most ${limit} strings of at most ${itemLimit} characters`;
    }
    return '';
  };
  for (const [name, limit, itemLimit] of [
    ['modifiers', 4, 20],
    ['paths', 10, 32_767],
    ['resourceTypes', 20, 40],
    ['values', 100, 4_096],
  ]) {
    const error = boundedStringArray(name, limit, itemLimit);
    if (error) return { ok: false, error };
  }
  const hasValue = (name) => (
    Object.hasOwn(input, name) && input[name] !== undefined && input[name] !== null
  );
  const matchingRequirements = actionContract.requiredAny.filter(
    (names) => names.every(hasValue),
  );
  if (actionContract.requiredAny.length && !matchingRequirements.length) {
    return {
      ok: false,
      error: `browser action "${action}" requires input.${
        actionContract.requiredAny.map((names) => names.join('+')).join(' or input.')
      }`,
    };
  }
  const touchedRequirements = actionContract.requiredAny.filter(
    (names) => names.some((name) => Object.hasOwn(input, name)),
  );
  if (touchedRequirements.length > 1) {
    return { ok: false, error: `browser action "${action}" accepts only one input target form` };
  }
  if (action === 'navigate' && !hasValue('url') && input.reload !== true) {
    return { ok: false, error: 'browser action "navigate" requires input.url or input.reload=true' };
  }
  if (action === 'fill' && Object.hasOwn(input, 'fields')) {
    if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 30) {
      return { ok: false, error: 'browser action "fill" input.fields requires 1 to 30 items' };
    }
    const allowedFieldNames = new Set(['ref', 'text', 'value', 'values', 'checked']);
    for (let index = 0; index < input.fields.length; index += 1) {
      const field = input.fields[index];
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        return { ok: false, error: `browser action "fill" input.fields[${index}] must be an object` };
      }
      const unsupportedFieldNames = Object.keys(field).filter((name) => !allowedFieldNames.has(name));
      if (unsupportedFieldNames.length) {
        return {
          ok: false,
          error: `browser action "fill" input.fields[${index}] does not accept field(s): ${unsupportedFieldNames.join(', ')}`,
        };
      }
      if (typeof field.ref !== 'string' || !field.ref.trim()) {
        return { ok: false, error: `browser action "fill" input.fields[${index}] requires ref` };
      }
      const hasText = typeof field.text === 'string';
      const hasValue = typeof field.value === 'string';
      const hasValues = Array.isArray(field.values)
        && field.values.length > 0
        && field.values.length <= 100
        && field.values.every((value) => typeof value === 'string');
      const hasChecked = typeof field.checked === 'boolean';
      const payloadCount = Number(hasText || hasValue) + Number(hasValues) + Number(hasChecked);
      if (payloadCount !== 1 || (hasText && hasValue)) {
        return {
          ok: false,
          error: `browser action "fill" input.fields[${index}] requires exactly one of text/value, values, or checked`,
        };
      }
      if (field.ref.length > 128
        || (hasText && field.text.length > 100_000)
        || (hasValue && field.value.length > 100_000)
        || (hasValues && field.values.some((value) => value.length > 4_096))) {
        return { ok: false, error: `browser action "fill" input.fields[${index}] is too large` };
      }
    }
  }
  if (action === 'scroll') {
    const targetForms = [['ref'], ['snapshotId', 'x', 'y'], ['text']];
    const touchedTargets = targetForms.filter(
      (names) => names.some((name) => Object.hasOwn(input, name)),
    );
    if (touchedTargets.length > 1) {
      return { ok: false, error: 'browser action "scroll" accepts only one input target form' };
    }
    if (touchedTargets.length && !touchedTargets[0].every(hasValue)) {
      return {
        ok: false,
        error: `browser action "scroll" target requires input.${touchedTargets[0].join('+')}`,
      };
    }
  }
  const screenshotOptionsTouched = SCREENSHOT_OPTIONS.some(
    (name) => Object.hasOwn(input, name),
  );
  if (action === 'snapshot' && screenshotOptionsTouched) {
    const mode = String(input.mode || 'semantic');
    if (mode === 'semantic') {
      return { ok: false, error: 'browser action "snapshot" screenshot options require input.mode=visual or input.mode=both' };
    }
    if (input.fullPage === true && mode === 'both') {
      return { ok: false, error: 'browser action "snapshot" fullPage is inspection-only and requires input.mode=visual' };
    }
  } else if (screenshotOptionsTouched && input.includeScreenshot !== true) {
    return { ok: false, error: `browser action "${action}" screenshot options require input.includeScreenshot=true` };
  }
  if (input.format !== 'jpeg' && Object.hasOwn(input, 'quality')) {
    return { ok: false, error: 'browser screenshot input.quality is supported only with input.format=jpeg' };
  }
  if (input.format === 'pdf') {
    if (action !== 'snapshot' || String(input.mode || 'semantic') !== 'visual') {
      return { ok: false, error: 'browser format=pdf requires action "snapshot" with input.mode=visual' };
    }
    if (Object.hasOwn(input, 'image_output') && input.image_output !== 'file') {
      return { ok: false, error: 'browser format=pdf always writes a file; drop input.image_output' };
    }
  }
  if (action === 'click' && input.pointer === 'touch'
    && (input.button !== undefined || input.modifiers !== undefined || input.doubleClick === true)) {
    return {
      ok: false,
      error: 'browser action "click" pointer=touch does not accept button, modifiers, or doubleClick',
    };
  }
  if (action === 'upload' && input.confirm !== true) {
    return { ok: false, error: 'browser action "upload" requires input.confirm=true after path approval' };
  }
  if (action === 'sequence') {
    const error = validateSequenceSteps(input.steps);
    if (error) return { ok: false, error };
  }
  if (action === 'extract') {
    if (typeof input.selector !== 'string' || !input.selector.trim()) {
      return { ok: false, error: 'browser action "extract" requires a non-empty input.selector' };
    }
    if (Object.hasOwn(input, 'attributes')) {
      const names = input.attributes;
      if (!Array.isArray(names) || !names.length || names.length > 12
        || !names.every((name) => typeof name === 'string' && name.trim() && name.length <= 60)) {
        return {
          ok: false,
          error: 'browser action "extract" input.attributes requires 1 to 12 attribute names',
        };
      }
    }
  }
  if (action === 'emulate') {
    if (hasValue('latitude') !== hasValue('longitude')) {
      return {
        ok: false,
        error: 'browser action "emulate" geolocation requires input.latitude and input.longitude together',
      };
    }
    if (Object.hasOwn(input, 'accuracy') && !hasValue('latitude')) {
      return { ok: false, error: 'browser action "emulate" input.accuracy requires latitude and longitude' };
    }
    if (Object.hasOwn(input, 'headers')) {
      const headers = input.headers;
      const names = headers && typeof headers === 'object' && !Array.isArray(headers)
        ? Object.keys(headers)
        : null;
      if (!names || !names.length || names.length > 20
        || !names.every((name) => typeof headers[name] === 'string')) {
        return {
          ok: false,
          error: 'browser action "emulate" input.headers requires 1 to 20 header names with string values',
        };
      }
    }
  }
  if (Object.hasOwn(input, 'expect')) {
    const expected = input.expect;
    const allowedExpected = new Set(['text', 'textGone', 'url', 'timeoutMs']);
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || Object.keys(expected).some((name) => !allowedExpected.has(name))
      || ['text', 'textGone', 'url'].some((name) => (
        Object.hasOwn(expected, name)
        && (typeof expected[name] !== 'string' || expected[name].length > 10_000)
      ))) {
      return { ok: false, error: `browser action "${action}" input.expect is invalid or too large` };
    }
  }
  if (action === 'intercept' || action === 'init_script') {
    const operation = String(input.operation || 'list').trim().toLowerCase();
    if (!['add', 'remove', 'list', 'clear'].includes(operation)) {
      return {
        ok: false,
        error: `browser action "${action}" operation must be add, remove, list, or clear`,
      };
    }
    const ruleFields = action === 'intercept'
      ? ['url', 'abort', 'body', 'resourceTypes']
      : ['script'];
    const strayRuleFields = operation === 'add'
      ? []
      : ruleFields.filter((name) => Object.hasOwn(input, name));
    if (strayRuleFields.length) {
      return {
        ok: false,
        error: `browser action "${action}" ${operation} does not accept input field(s): ${strayRuleFields.join(', ')}`,
      };
    }
    const handle = action === 'intercept' ? 'ruleId' : 'scriptId';
    if (operation === 'remove'
      && (typeof input[handle] !== 'string' || !input[handle].trim())) {
      return {
        ok: false,
        error: `browser action "${action}" remove requires input.${handle} from an ${action} list`,
      };
    }
    if (operation !== 'remove' && Object.hasOwn(input, handle)) {
      return { ok: false, error: `browser action "${action}" input.${handle} belongs to remove` };
    }
    if (operation === 'add') {
      if (action === 'init_script'
        && (typeof input.script !== 'string' || !input.script.trim())) {
        return { ok: false, error: 'browser action "init_script" add requires input.script' };
      }
      if (action === 'intercept') {
        if (typeof input.url !== 'string' || !input.url.trim()) {
          return {
            ok: false,
            error: 'browser action "intercept" add requires input.url, a wildcard pattern such as "*/api/*"',
          };
        }
        const replacesBody = Object.hasOwn(input, 'body');
        if (input.abort === true && replacesBody) {
          return {
            ok: false,
            error: 'browser action "intercept" add takes input.abort or input.body, not both',
          };
        }
        if (input.abort !== true && !replacesBody) {
          return {
            ok: false,
            error: 'browser action "intercept" add requires input.abort=true or input.body',
          };
        }
      }
    }
  }
  return { ok: true, action, input };
}
