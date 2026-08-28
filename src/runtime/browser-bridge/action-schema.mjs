const PAGE_TARGET = ['tab', 'background'];
const SNAPSHOT_FILTERS = ['query', 'viewportOnly', 'maxElements', 'maxChars'];
const SCREENSHOT_OPTIONS = ['fullPage', 'format', 'quality'];
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
    'cpuThrottlingRate', 'orientation', 'reset',
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
  contract('select', [...POST_ACTION_SNAPSHOT, 'ref', 'values'], ['ref', 'values']),
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
  contract('scroll', [
    ...POST_ACTION_SNAPSHOT, 'ref', 'snapshotId', 'x', 'y', 'dx', 'dy',
  ]),
  contract(['back', 'forward'], POST_ACTION_SNAPSHOT),
  contract('read', [...PAGE_TARGET, 'query', 'maxChars', 'offset']),
  contract('wait', [...PAGE_TARGET, ...SNAPSHOT_FILTERS, 'text', 'textGone', 'url', 'timeoutMs']),
  contract('status', PAGE_TARGET),
  contract('console', [...PAGE_TARGET, 'level', 'query', 'limit']),
  contract('network', [
    ...PAGE_TARGET, 'requestId', 'resourceTypes', 'limit', 'frameLimit', 'maxChars', 'query',
  ]),
  contract('list_tabs'),
  contract('close_tab', ['tab'], ['tab']),
  contract('downloads', ['downloadId', 'wait', 'attach', 'timeoutMs']),
  contract('open', PAGE_TARGET),
];

export const BROWSER_ACTIONS = Object.freeze(CONTRACT_ROWS.flatMap(({ actions }) => actions));
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

  const hasNestedInput = Object.hasOwn(args, 'input');
  let input;
  if (hasNestedInput) {
    if (args.input == null) input = {};
    else if (typeof args.input === 'object' && !Array.isArray(args.input)) input = { ...args.input };
    else return { ok: false, error: `browser action "${action}" input must be an object` };
    const topLevelFields = Object.keys(args).filter((name) => name !== 'action' && name !== 'input');
    if (topLevelFields.length) {
      return {
        ok: false,
        error: `browser action "${action}" fields must be inside input: ${topLevelFields.join(', ')}`,
      };
    }
  } else {
    input = Object.fromEntries(Object.entries(args).filter(([name]) => name !== 'action'));
  }

  const allowed = new Set(actionContract.fields);
  const unsupported = Object.keys(input).filter((name) => !allowed.has(name));
  if (unsupported.length) {
    return {
      ok: false,
      error: `browser action "${action}" does not accept input field(s): ${unsupported.join(', ')}`,
    };
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
        && field.values.every((value) => typeof value === 'string');
      const hasChecked = typeof field.checked === 'boolean';
      const payloadCount = Number(hasText || hasValue) + Number(hasValues) + Number(hasChecked);
      if (payloadCount !== 1 || (hasText && hasValue)) {
        return {
          ok: false,
          error: `browser action "fill" input.fields[${index}] requires exactly one of text/value, values, or checked`,
        };
      }
    }
  }
  if (action === 'scroll') {
    const targetForms = [['ref'], ['snapshotId', 'x', 'y']];
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
  const screenshotOptionsTouched = ['fullPage', 'format', 'quality'].some(
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
  if (input.format === 'png' && Object.hasOwn(input, 'quality')) {
    return { ok: false, error: 'browser screenshot input.quality is supported only with input.format=jpeg' };
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
  return { ok: true, action, input };
}
