import { splitBridgeToolArgs } from '../shared/bridge-tool-args.mjs';
import {
  BROWSER_ACTIONS,
  BROWSER_DEVTOOLS_ACTIONS,
  BROWSER_OBSERVATION_ACTIONS,
  BROWSER_PAGE_ACTIONS,
  BROWSER_SEQUENCE_STEP_ACTIONS,
  browserToolForAction,
} from './browser-action-contract.mjs';

/** Actions that only observe the page. Naming them on the tool surface lets a
 *  caller repeat or overlap them without wondering whether they change state;
 *  the host enforces the same list when it decides what may run concurrently. */
export {
  BROWSER_ACTIONS,
  BROWSER_DEVTOOLS_ACTIONS,
  BROWSER_OBSERVATION_ACTIONS,
  BROWSER_PAGE_ACTIONS,
};

const PAGE_TARGET = ['tab', 'background'];
const SNAPSHOT_FILTERS = ['query', 'viewportOnly', 'maxElements', 'maxChars'];
const SCREENSHOT_OPTIONS = ['fullPage', 'format', 'quality', 'image_output'];
const POST_ACTION = ['expect', 'settleMs', 'brief'];
/** Snapshot-free element target: role and/or accessible name, or a CSS selector. */
const TARGET_FIELDS = new Set(['role', 'name', 'selector', 'exact', 'nth']);
/** Actions whose query is keywords-or-regex over page content; the others
 *  (network, console, locate) keep their own substring or visual semantics. */
const QUERY_SYNTAX_ACTIONS = new Set(['snapshot', 'read', 'wait']);
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
  contract('snapshot', [...PAGE_TARGET, ...SNAPSHOT_FILTERS, 'mode', ...SCREENSHOT_OPTIONS, 'settleMs']),
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
  contract('performance', [...PAGE_TARGET, 'operation', 'reload', 'saveTrace']),
  contract(
    'click',
    [
      ...POST_ACTION_SNAPSHOT, 'ref', 'target', 'snapshotId', 'x', 'y', 'pointer',
      'button', 'modifiers', 'doubleClick',
    ],
    [['ref'], ['target'], ['snapshotId', 'x', 'y']],
  ),
  // One control takes text or a checked state; a batch takes fields.
  contract(
    'fill',
    [...POST_ACTION_SNAPSHOT, 'ref', 'target', 'text', 'checked', 'fields', 'submit'],
    [['ref', 'text'], ['target', 'text'], ['ref', 'checked'], ['target', 'checked'], ['fields']],
  ),
  contract(
    'type',
    [...POST_ACTION_SNAPSHOT, 'ref', 'target', 'text', 'submit'],
    [['ref', 'text'], ['target', 'text']],
  ),
  // Without values, select reads the control's options instead of choosing.
  contract('select', [...POST_ACTION_SNAPSHOT, 'ref', 'target', 'values'], [['ref'], ['target']]),
  contract(
    'hover',
    [...POST_ACTION_SNAPSHOT, 'ref', 'target', 'snapshotId', 'x', 'y'],
    [['ref'], ['target'], ['snapshotId', 'x', 'y']],
  ),
  contract(
    'drag',
    [
      ...POST_ACTION_SNAPSHOT, 'ref', 'targetRef', 'snapshotId', 'x', 'y',
      'targetX', 'targetY', 'pointer',
    ],
    [['ref', 'targetRef'], ['snapshotId', 'x', 'y', 'targetX', 'targetY']],
  ),
  // ref is optional: without it upload answers the file chooser the page has
  // already opened; with a non-file ref it clicks that element to open one.
  contract('upload', [...POST_ACTION_SNAPSHOT, 'ref', 'target', 'paths'], ['paths']),
  contract('handle_dialog', [...POST_ACTION_SNAPSHOT, 'accept', 'promptText']),
  contract('press', [...POST_ACTION_SNAPSHOT, 'key'], ['key']),
  // text brings the first match into view when its position is unknown.
  contract('scroll', [
    ...POST_ACTION_SNAPSHOT, 'ref', 'target', 'snapshotId', 'x', 'y', 'dx', 'dy', 'text',
  ]),
  // Forward history is reached by navigating to the URL the caller already
  // saw; only back needs a gesture of its own.
  contract('back', POST_ACTION_SNAPSHOT),
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
  contract('hide'),
];

/** Steps a sequence may run. Everything here is deterministic on one page;
 *  navigation, uploads, and dialogs stay single calls so their fresh snapshot
 *  is always inspected before the next decision. */
const SEQUENCE_STEP_FIELDS = Object.freeze({
  click: ['ref', 'target'],
  fill: ['ref', 'target', 'text', 'checked', 'submit'],
  type: ['ref', 'target', 'text', 'submit'],
  select: ['ref', 'target', 'values'],
  hover: ['ref', 'target'],
  press: ['key'],
  scroll: ['ref', 'target', 'dx', 'dy'],
  wait: ['text', 'textGone', 'url', 'timeoutMs'],
});
const SEQUENCE_STEP_REQUIRED = Object.freeze({
  click: [['ref'], ['target']],
  fill: [['ref', 'text'], ['target', 'text'], ['ref', 'checked'], ['target', 'checked']],
  type: [['ref', 'text'], ['target', 'text']],
  select: [['ref', 'values'], ['target', 'values']],
  hover: [['ref'], ['target']],
  press: [['key']],
  scroll: [],
  wait: [['text'], ['textGone'], ['url']],
});
export const SEQUENCE_STEP_ACTIONS = BROWSER_SEQUENCE_STEP_ACTIONS;

/** A target names one element by role and/or accessible name, or by a CSS
 *  selector; the host insists on exactly one match at dispatch time. */
function validateTargetSpec(spec, at) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return `${at} must be an object with role, name, and/or selector`;
  }
  const unsupported = Object.keys(spec).filter((name) => !TARGET_FIELDS.has(name));
  if (unsupported.length) return `${at} does not accept field(s): ${unsupported.join(', ')}`;
  for (const [name, limit] of [['role', 60], ['name', 500], ['selector', 4_096]]) {
    if (Object.hasOwn(spec, name) && (typeof spec[name] !== 'string' || spec[name].length > limit)) {
      return `${at}.${name} must be a string of at most ${limit} characters`;
    }
  }
  if (Object.hasOwn(spec, 'exact') && typeof spec.exact !== 'boolean') return `${at}.exact must be a boolean`;
  if (Object.hasOwn(spec, 'nth') && (!Number.isInteger(spec.nth) || spec.nth < 1 || spec.nth > 500)) {
    return `${at}.nth must be an integer from 1 to 500`;
  }
  const present = (name) => typeof spec[name] === 'string' && spec[name].trim().length > 0;
  if (!present('role') && !present('name') && !present('selector')) {
    return `${at} requires role, name, and/or selector`;
  }
  if (spec.exact === true && !present('name')) return `${at}.exact applies to name`;
  return '';
}

/** Keywords match with OR; `/pattern/` or `/pattern/i` is a regular
 *  expression and must compile. Other flags change matching semantics the
 *  page-side matcher does not implement, so they are refused. */
function validateQuerySyntax(query, at) {
  if (typeof query !== 'string') return '';
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(query.trim());
  if (!regex) return '';
  if (regex[2].replace(/i/g, '').length) {
    return `${at} regular expression accepts only the i flag`;
  }
  try {
    new RegExp(regex[1], regex[2].includes('i') ? 'i' : '');
  } catch (error) {
    return `${at} regular expression is invalid: ${error.message}`;
  }
  return '';
}

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
    if (present('ref') && present('target')) return `${at} accepts ref or target, not both`;
    if (Object.hasOwn(step, 'target')) {
      const targetError = validateTargetSpec(step.target, `${at}.target`);
      if (targetError) return targetError;
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
function requiredSummary(actions) {
  const wanted = new Set(actions);
  return CONTRACT_ROWS
    .filter(({ actions: rowActions, requiredAny }) => (
      requiredAny.length && rowActions.some((name) => wanted.has(name))
    ))
    .map(({ actions: rowActions, requiredAny }) => (
      `${rowActions.filter((name) => wanted.has(name)).join('/')} ${requiredAny.map((names) => names.join('+')).join(' or ')}`
    ))
    .join('; ');
}

/** One tool's input schema from the shared flat field list: the action enum is
 *  the tool's own subset and only the fields those actions accept ride along,
 *  so the default `browser` tool never carries a cookie attribute or a CPU
 *  throttle it cannot use. */
export function buildBrowserInputSchema(flatSchema, actions = BROWSER_ACTIONS) {
  const properties = flatSchema?.properties || {};
  const { action, ...inputProperties } = properties;
  const fieldNames = new Set(
    actions.flatMap((name) => CONTRACT_BY_ACTION.get(name)?.fields || []),
  );
  const scoped = Object.fromEntries(
    Object.entries(inputProperties).filter(([name]) => fieldNames.has(name)),
  );
  return {
    type: 'object',
    description: 'Choose one Browser Use action and pass only its fields in input.',
    properties: {
      action: { ...action, enum: [...actions] },
      input: {
        type: 'object',
        description: `Fields for the selected action. Required: ${requiredSummary(actions)}. Omit input when no fields are needed.`,
        properties: scoped,
      },
    },
    required: ['action'],
  };
}

/** `options.tool` names the tool that received the call; an action that
 *  belongs to the other browser tool is refused with the tool to call, so a
 *  model that guessed the wrong surface learns the split from the error. */
export function validateBrowserToolArgs(args, options = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'browser arguments must be an object' };
  }
  const action = String(args.action || '').trim();
  const actionContract = CONTRACT_BY_ACTION.get(action);
  if (!actionContract) {
    return { ok: false, error: `unknown browser action "${action || '(empty)'}"` };
  }
  const tool = String(options?.tool || '').trim();
  const owner = browserToolForAction(action);
  if (tool && tool !== owner) {
    return {
      ok: false,
      error: `browser action "${action}" belongs to the ${owner} tool; call ${owner} with the same input`,
    };
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
  if (Object.hasOwn(input, 'target')) {
    const targetError = validateTargetSpec(input.target, `browser action "${action}" input.target`);
    if (targetError) return { ok: false, error: targetError };
  }
  if (QUERY_SYNTAX_ACTIONS.has(action) && Object.hasOwn(input, 'query')) {
    const queryError = validateQuerySyntax(input.query, `browser action "${action}" input.query`);
    if (queryError) return { ok: false, error: queryError };
  }
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
  // Exactly one target form: a second complete form, or a field that belongs
  // only to another form (ref beside snapshotId), is a contradiction.
  const matched = new Set(matchingRequirements[0] || []);
  const strayForm = actionContract.requiredAny.some((names) => (
    names !== matchingRequirements[0]
    && names.some((name) => Object.hasOwn(input, name) && !matched.has(name))
  ));
  if (matchingRequirements.length > 1 || strayForm) {
    return { ok: false, error: `browser action "${action}" accepts only one input target form` };
  }
  if (action === 'navigate' && !hasValue('url') && input.reload !== true) {
    return { ok: false, error: 'browser action "navigate" requires input.url or input.reload=true' };
  }
  if (action === 'fill' && Object.hasOwn(input, 'fields')) {
    if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 30) {
      return { ok: false, error: 'browser action "fill" input.fields requires 1 to 30 items' };
    }
    const allowedFieldNames = new Set(['ref', 'target', 'text', 'value', 'values', 'checked']);
    let targetedFields = 0;
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
      const hasRef = typeof field.ref === 'string' && field.ref.trim().length > 0;
      const hasTarget = Object.hasOwn(field, 'target');
      if (hasRef === hasTarget) {
        return { ok: false, error: `browser action "fill" input.fields[${index}] requires ref or target, not both` };
      }
      if (hasTarget) {
        const targetError = validateTargetSpec(field.target, `browser action "fill" input.fields[${index}].target`);
        if (targetError) return { ok: false, error: targetError };
        targetedFields += 1;
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
      if ((hasRef && field.ref.length > 128)
        || (hasText && field.text.length > 100_000)
        || (hasValue && field.value.length > 100_000)
        || (hasValues && field.values.some((value) => value.length > 4_096))) {
        return { ok: false, error: `browser action "fill" input.fields[${index}] is too large` };
      }
    }
    // Targets resolve against one fresh observation that retires the caller's
    // refs, so a batch is addressed one way or the other.
    if (targetedFields && targetedFields !== input.fields.length) {
      return { ok: false, error: 'browser action "fill" input.fields must use ref for every item or target for every item' };
    }
  }
  if (action === 'scroll') {
    const targetForms = [['ref'], ['target'], ['snapshotId', 'x', 'y'], ['text']];
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
  if (action === 'sequence') {
    const error = validateSequenceSteps(input.steps);
    if (error) return { ok: false, error };
  }
  if (Object.hasOwn(input, 'saveTrace')
    && (typeof input.saveTrace !== 'boolean' || input.operation !== 'start')) {
    return { ok: false, error: 'performance saveTrace requires operation=start and a boolean' };
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
