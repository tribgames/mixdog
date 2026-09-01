import { splitBridgeToolArgs } from '../shared/bridge-tool-args.mjs';
import {
  COMPUTER_CORE_ACTION_SCHEMA,
  validateComputerCoreActions,
} from './core-actions.mjs';

/** Actions that only observe the desktop. Naming them on the tool surface lets
 *  a caller repeat one without wondering whether it moved anything; the host
 *  enforces the same split when it decides which session owns a write. */
export const COMPUTER_OBSERVATION_ACTIONS = Object.freeze([
  'list', 'diagnose', 'capture', 'verify',
]);

const MAX_CLIPBOARD_TEXT_LENGTH = 50_000;
const MAX_TARGET_TOKEN_LENGTH = 4_096;
const OCR_LANGUAGE_TAG_PATTERN = '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$';

const ocrLanguage = {
  type: 'string',
  minLength: 2,
  maxLength: 64,
  pattern: OCR_LANGUAGE_TAG_PATTERN,
};

const ACTIONS = [
  'list', 'diagnose', 'capture', 'verify',
  'act', 'window', 'menu', 'clipboard', 'launch',
];

const windowTarget = {
  window_id: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TARGET_TOKEN_LENGTH,
    description: 'Exact id from list(kind="windows"), e.g. hwnd:0x123ABC.',
  },
};

const appTarget = {
  app: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TARGET_TOKEN_LENGTH,
    description: 'Resolves to one exact window; ambiguous matches are refused.',
  },
};

const delivery = {
  delivery: {
    type: 'string',
    enum: ['background', 'foreground'],
    description: 'Background by default; foreground is a visible escalation.',
  },
};

function input(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function branch(actions, actionInput, inputRequired = true) {
  const names = Array.isArray(actions) ? actions : [actions];
  return {
    properties: {
      action: { enum: names },
      input: actionInput,
    },
    required: inputRequired ? ['action', 'input'] : ['action'],
  };
}

const captureProperties = {
  ...windowTarget,
  app: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TARGET_TOKEN_LENGTH,
    description: 'App name used only when it resolves to one exact window.',
  },
  screen: {
    type: 'integer',
    minimum: 0,
    description: 'Display index for a plain vision capture.',
  },
  mode: {
    type: 'string',
    enum: ['state', 'som', 'vision', 'ax', 'zoom'],
    description: 'state (default) is structured UI plus image; som adds marks; vision is image only; ax is accessibility only; zoom crops a prior frame.',
  },
  frame_id: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TARGET_TOKEN_LENGTH,
    description: 'Latest unexpired frame id; required with mode="zoom".',
  },
  region: {
    type: 'array',
    items: { type: 'integer' },
    minItems: 4,
    maxItems: 4,
    description: 'mode="zoom": [x0,y0,x1,y1] in frame coordinates.',
  },
  include_ocr: {
    type: 'boolean',
    description: 'State/SOM automatically use offline Windows OCR when semantic targets are absent; true always runs OCR even when semantic targets exist. OCR shares max_elements.',
  },
  ocr_language: {
    ...ocrLanguage,
    description: 'Installed Windows OCR language tag, e.g. ko or en-US.',
  },
  max_ocr_words: {
    type: 'integer',
    minimum: 1,
    maximum: 1000,
  },
  image_output: {
    type: 'string',
    enum: ['inline', 'file'],
    description: 'inline (default) returns the frame here; file writes it beside the run and returns its path, keeping large pixels out of the conversation.',
  },
  query: { type: 'string', maxLength: MAX_TARGET_TOKEN_LENGTH },
  role: { type: 'string', maxLength: MAX_TARGET_TOKEN_LENGTH },
  visible_only: { type: 'boolean' },
  include_noninteractive: { type: 'boolean' },
  max_elements: {
    type: 'integer',
    minimum: 1,
    maximum: 1000,
    description: 'Total returned accessibility + OCR element budget. state defaults to 80.',
  },
  continuation: { type: 'string', maxLength: MAX_TARGET_TOKEN_LENGTH },
  quality: {
    type: 'integer',
    minimum: 0,
    maximum: 100,
  },
  maxWidth: {
    type: 'integer',
    minimum: 256,
    maximum: 3840,
  },
};

export const COMPUTER_INPUT_SCHEMA = {
  type: 'object',
  description: 'One compact Computer Use operation. Use act.actions to execute 1-6 simple actions and receive one fresh observation.',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'Use capture to observe, act for simple input actions, and the remaining operations only for their named advanced capability.',
    },
    input: {
      type: 'object',
      description: 'Fields for the selected action.',
    },
  },
  required: ['action'],
  additionalProperties: false,
  oneOf: [
    branch('list', input({
      kind: { type: 'string', enum: ['windows', 'apps'] },
    }, ['kind'])),
    branch('diagnose', input({
      ...windowTarget,
      ocr_language: {
        ...ocrLanguage,
        description: 'Optional Windows OCR language tag to verify, e.g. ko or en-US.',
      },
    }), false),
    branch('capture', input(captureProperties), false),
    branch('act', input({
      ...windowTarget,
      ...appTarget,
      frame_id: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TARGET_TOKEN_LENGTH,
        description: 'Latest unexpired frame id shared by coordinate actions in this act call.',
      },
      actions: {
        type: 'array',
        items: COMPUTER_CORE_ACTION_SCHEMA,
        minItems: 1,
        maxItems: 6,
        description: 'Simple actions executed in order. A transition or failure halts the remaining actions.',
      },
      ...delivery,
    }, ['actions'])),
    branch('window', input({
      ...windowTarget,
      ...appTarget,
      operation: {
        type: 'string',
        enum: ['focus', 'move', 'minimize', 'maximize', 'restore', 'close'],
      },
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
    }, ['operation'])),
    branch('menu', input({
      ...windowTarget,
      ...appTarget,
      path: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 512 },
        minItems: 1,
        maxItems: 8,
        description: 'Exact labels from the bar down, e.g. ["File","Save As"]. Missing, ambiguous, or disabled entries fail closed.',
      },
    }, ['path'])),
    branch('verify', input({
      ...windowTarget,
      ...appTarget,
      expect: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        description: 'AND-combined predicates. Reads state only: no pixels, and prior refs stay valid.',
        items: {
          type: 'object',
          properties: {
            present: {
              type: 'string',
              maxLength: MAX_TARGET_TOKEN_LENGTH,
              description: 'Text an element name or value must contain.',
            },
            absent: { type: 'string', maxLength: MAX_TARGET_TOKEN_LENGTH },
            title_contains: { type: 'string', maxLength: MAX_TARGET_TOKEN_LENGTH },
            window_exists: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 30000 },
      stable_samples: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'Consecutive satisfied samples required. Default 2.',
      },
    }, ['expect'])),
    branch('clipboard', input({
      operation: { type: 'string', enum: ['read', 'write'] },
      text: {
        type: 'string',
        maxLength: MAX_CLIPBOARD_TEXT_LENGTH,
        description: 'Required for operation="write".',
      },
    }, ['operation'])),
    branch('launch', input({
      app: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TARGET_TOKEN_LENGTH,
        description: 'Executable name, exact path, file, or URL.',
      },
    }, ['app'])),
  ],
};

const COMPUTER_ACTION_BRANCHES = new Map();
for (const actionBranch of COMPUTER_INPUT_SCHEMA.oneOf) {
  for (const action of actionBranch.properties?.action?.enum || []) {
    COMPUTER_ACTION_BRANCHES.set(action, actionBranch);
  }
}

// Actions that drive one exact window. They carry exactly one window target:
// the exact window_id, or an app label the host resolves to one window and
// refuses when it matches more than one.
const WINDOW_TARGET_ACTIONS = new Set([
  'act', 'window', 'menu', 'verify',
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function schemaValueError(value, schema, path) {
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(', ')}`;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} requires at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} accepts at most ${schema.maxLength} characters`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${path} must match the required format`;
    }
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean`;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return `${path} must be a finite number`;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} requires at least ${schema.minItems} items`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path} accepts at most ${schema.maxItems} items`;
    }
    for (let index = 0; index < value.length; index += 1) {
      const itemError = schemaValueError(value[index], schema.items || {}, `${path}[${index}]`);
      if (itemError) return itemError;
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path} must be at least ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path} must be at most ${schema.maximum}`;
    }
  }
  return null;
}

function objectSchemaValueError(value, schema, path) {
  for (const [name, item] of Object.entries(value)) {
    const error = schemaValueError(item, schema.properties?.[name] || {}, `${path}.${name}`);
    if (error) return error;
  }
  return null;
}

/** Absorb the two transport shapes a provider can emit for a nested argument:
 *  a JSON-serialized `input`, or input fields flattened
 *  onto the argument root. A shape that stays unresolved is left exactly as it
 *  arrived, so validation still reports it. */
export function normalizeComputerToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { hasNestedInput, input } = splitBridgeToolArgs(args, ['action']);
  const normalized = { ...args };
  if (hasNestedInput) {
    normalized.input = input;
  } else if (Object.keys(input).length) {
    for (const key of Object.keys(input)) delete normalized[key];
    normalized.input = input;
  }
  return normalized;
}

export function validateComputerToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return 'Computer Use arguments must be an object';
  }
  const args = normalizeComputerToolArgs(rawArgs);
  const rootExtras = Object.keys(args).filter(
    (key) => !['action', 'input'].includes(key),
  );
  if (rootExtras.length) {
    return `Computer Use does not accept root field(s): ${rootExtras.join(', ')}`;
  }

  const name = String(args.action || '');
  const branch = COMPUTER_ACTION_BRANCHES.get(name);
  if (!branch) return `unknown Computer Use action: ${name || '(empty)'}`;

  const inputRequired = branch.required?.includes('input') === true;
  const inputValue = args.input;
  if (inputValue === undefined) {
    if (inputRequired) return `Computer Use action "${name}" requires input`;
  } else {
    if (!inputValue || typeof inputValue !== 'object' || Array.isArray(inputValue)) {
      return `Computer Use action "${name}" input must be an object`;
    }

    const strictInput = branch.properties?.input;
    const allowed = new Set(Object.keys(strictInput?.properties || {}));
    const extras = Object.keys(inputValue).filter((key) => !allowed.has(key));
    if (extras.length) {
      return `Computer Use action "${name}" does not accept input field(s): ${extras.join(', ')}`;
    }

    const missing = (strictInput?.required || []).filter((key) => !hasOwn(inputValue, key));
    if (missing.length) {
      return `Computer Use action "${name}" requires input field(s): ${missing.join(', ')}`;
    }
    const valueError = objectSchemaValueError(inputValue, strictInput, 'Computer Use input');
    if (valueError) return valueError;
  }

  const inputObject = inputValue || {};
  for (const field of ['window_id', 'app', 'frame_id']) {
    if (hasOwn(inputObject, field)
      && typeof inputObject[field] === 'string'
      && !inputObject[field].trim()) {
      return `Computer Use ${name} ${field} must not be empty`;
    }
  }
  if (WINDOW_TARGET_ACTIONS.has(name)) {
    const windowTargets = ['window_id', 'app'].filter((key) => hasOwn(inputObject, key));
    if (windowTargets.length !== 1) {
      return `Computer Use ${name} requires exactly one of window_id or app`;
    }
  }
  if (name === 'capture') {
    const mode = inputObject.mode || 'state';
    const captureTargets = ['window_id', 'app', 'screen'].filter(
      (key) => hasOwn(inputObject, key),
    );
    if (captureTargets.length > 1) {
      return 'Computer Use capture accepts at most one of window_id, app, or screen';
    }
    if (mode === 'zoom' && (!hasOwn(inputObject, 'frame_id') || !hasOwn(inputObject, 'region'))) {
      return 'Computer Use capture mode="zoom" requires input field(s): frame_id, region';
    }
    if (mode === 'zoom' && captureTargets.length) {
      return 'Computer Use capture mode="zoom" accepts frame_id and region instead of a window, app, or screen target';
    }
    if (mode !== 'zoom' && (hasOwn(inputObject, 'frame_id') || hasOwn(inputObject, 'region'))) {
      return 'Computer Use capture frame_id/region requires mode="zoom"';
    }
    if (mode === 'ax' && inputObject.include_ocr === true) {
      return 'Computer Use capture include_ocr is unavailable with mode="ax"';
    }
    if (mode === 'ax' && hasOwn(inputObject, 'image_output')) {
      return 'Computer Use capture image_output requires a mode that returns pixels';
    }
    if (hasOwn(inputObject, 'screen') && mode !== 'vision') {
      return 'Computer Use capture screen requires mode="vision"';
    }
  }
  if (name === 'menu') {
    const segments = inputObject.path || [];
    if (segments.some((segment) => typeof segment !== 'string' || !segment.trim())) {
      return 'Computer Use menu path segments must be non-empty labels';
    }
  }
  if (name === 'verify') {
    const allowed = ['present', 'absent', 'title_contains', 'window_exists'];
    const expectations = inputObject.expect || [];
    for (let index = 0; index < expectations.length; index += 1) {
      const predicate = expectations[index];
      if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) {
        return `Computer Use verify predicate ${index + 1} must be an object`;
      }
      const keys = Object.keys(predicate);
      const extras = keys.filter((key) => !allowed.includes(key));
      if (extras.length) {
        return `Computer Use verify predicate ${index + 1} does not accept field(s): ${extras.join(', ')}`;
      }
      if (keys.length !== 1) {
        return `Computer Use verify predicate ${index + 1} takes exactly one condition`;
      }
      const key = keys[0];
      if (key === 'window_exists') {
        if (typeof predicate[key] !== 'boolean') {
          return `Computer Use verify predicate ${index + 1} window_exists must be a boolean`;
        }
      } else {
        if (typeof predicate[key] !== 'string') {
          return `Computer Use verify predicate ${index + 1} text must be a string`;
        }
        if (!predicate[key].trim()) {
          return `Computer Use verify predicate ${index + 1} text must not be empty`;
        }
      }
    }
  }
  if (name === 'act') {
    const actionError = validateComputerCoreActions(inputObject.actions, {
      frameId: String(inputObject.frame_id || ''),
      delivery: String(inputObject.delivery || 'background'),
    });
    if (actionError) return actionError;
  }
  if (name === 'window' && inputObject.operation === 'move'
    && !['x', 'y', 'width', 'height'].some((key) => hasOwn(inputObject, key))) {
    return 'Computer Use window operation="move" requires x, y, width, or height';
  }
  if (name === 'clipboard') {
    if (inputObject.operation === 'write' && !hasOwn(inputObject, 'text')) {
      return 'Computer Use clipboard operation="write" requires input field: text';
    }
    if (inputObject.operation === 'read' && hasOwn(inputObject, 'text')) {
      return 'Computer Use clipboard operation="read" does not accept input field: text';
    }
  }
  if (name === 'launch') {
    const app = String(inputObject.app || '').trim();
    if (!app) return 'Computer Use launch app must not be empty';
    const httpUrl = /^https?:\/\//i.test(app);
    if (/[\r\n\0]|javascript:/i.test(app) || (!httpUrl && /&&|\|\|/.test(app))) {
      return 'Computer Use launch app must be one executable, file, or URL without command syntax';
    }
    if (!httpUrl && (
      /(?:^|[\\/"'])\s*(?:cmd|powershell|pwsh|wt|wsl|bash|sh|zsh|fish|nu|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?(?:["'\s]|$)/i.test(app)
      || /\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|appref-ms)(?:["']?\s*)$/i.test(app)
    )) {
      return 'Computer Use launch blocks shells, script hosts, and shortcut files; use an exact non-shell executable, document, or URL';
    }
  }
  return null;
}

export function toComputerHostCommand(rawArgs) {
  const args = normalizeComputerToolArgs(rawArgs);
  const inputValue = args.input || {};
  const command = { ...inputValue };
  switch (args.action) {
    case 'list':
      command.action = inputValue.kind === 'apps' ? 'list_apps' : 'list_windows';
      delete command.kind;
      break;
    case 'capture':
      command.action = inputValue.mode === 'zoom' ? 'zoom' : 'capture';
      if (command.action === 'zoom') delete command.mode;
      break;
    case 'menu':
      command.action = 'invoke_menu';
      break;
    case 'act':
      command.action = 'sequence';
      command.steps = inputValue.actions.map((step) => {
        const translated = { ...step, action: step.type };
        delete translated.type;
        if (step.type === 'click') {
          translated.action = step.button === 'right'
            ? 'right_click'
            : step.button === 'middle'
              ? 'middle_click'
              : step.ref
                ? 'invoke'
                : 'click';
          delete translated.button;
        }
        if (step.type === 'move') translated.action = 'mouse_move';
        if (inputValue.frame_id
          && ['x', 'y', 'to_x', 'to_y'].some((field) => hasOwn(step, field))) {
          translated.frame_id = inputValue.frame_id;
        }
        return translated;
      });
      delete command.actions;
      delete command.frame_id;
      break;
    case 'window':
      command.action = inputValue.operation === 'focus'
        ? 'focus_window'
        : inputValue.operation === 'move'
          ? 'move_window'
          : inputValue.operation === 'close'
            ? 'close_window'
            : 'window_state';
      if (command.action === 'window_state') command.state = inputValue.operation;
      delete command.operation;
      break;
    case 'clipboard':
      command.action = inputValue.operation === 'write' ? 'clipboard_write' : 'clipboard_read';
      delete command.operation;
      break;
    default:
      command.action = args.action;
  }
  return command;
}
