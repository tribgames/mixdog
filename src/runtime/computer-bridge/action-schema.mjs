const ACTIONS = [
  'list', 'diagnose', 'capture', 'verify',
  'click', 'double_click', 'mouse_move', 'drag', 'type', 'key', 'scroll', 'wait',
  'sequence', 'window', 'menu', 'clipboard', 'launch',
];

const windowTarget = {
  window_id: {
    type: 'string',
    description: 'Exact id returned by list(kind="windows"), e.g. hwnd:0x123ABC.',
  },
};

const appTarget = {
  app: {
    type: 'string',
    description: 'Resolves to one exact window when no window_id is known; ambiguous matches are refused.',
  },
};

const elementTarget = {
  ref: {
    type: 'string',
    description: 'Fresh semantic ref from capture.',
  },
  element: {
    type: 'integer',
    minimum: 1,
    description: 'Fresh 1-based SOM mark, including OCR marks.',
  },
};

const framePoint = {
  frame_id: {
    type: 'string',
    description: 'Fresh frame id from capture.',
  },
  x: {
    type: 'integer',
    description: 'Frame-relative X coordinate.',
  },
  y: {
    type: 'integer',
    description: 'Frame-relative Y coordinate.',
  },
};

const delivery = {
  delivery: {
    type: 'string',
    enum: ['background', 'foreground'],
    description: 'Background by default. Foreground is an explicit visible escalation.',
  },
};

const captureAfter = {
  type: 'object',
  description: 'Optional settings for the mandatory fresh observation returned after a UI mutation.',
  properties: {
    delay_ms: { type: 'integer', minimum: 0, maximum: 2000 },
    mode: { type: 'string', enum: ['state', 'som', 'vision', 'ax'] },
    max_elements: { type: 'integer', minimum: 1, maximum: 1000 },
    include_ocr: { type: 'boolean' },
    ocr_language: { type: 'string' },
    max_ocr_words: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  additionalProperties: false,
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
    description: 'Required with mode="zoom".',
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
    description: 'Allow offline Windows OCR only as a fallback when semantic accessibility targets are absent. OCR shares max_elements.',
  },
  ocr_language: {
    type: 'string',
    description: 'Installed Windows OCR language tag, e.g. ko or en-US.',
  },
  max_ocr_words: {
    type: 'integer',
    minimum: 1,
    maximum: 1000,
  },
  query: { type: 'string' },
  role: { type: 'string' },
  visible_only: { type: 'boolean' },
  include_noninteractive: { type: 'boolean' },
  max_elements: {
    type: 'integer',
    minimum: 1,
    maximum: 1000,
    description: 'Total returned accessibility + OCR element budget. state defaults to 80.',
  },
  continuation: { type: 'string' },
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

const pointerProperties = {
  ...windowTarget,
  ...appTarget,
  ...elementTarget,
  ...framePoint,
  modifiers: {
    type: 'string',
    description: 'ctrl, shift, alt, win, or a +-joined combination.',
  },
  ...delivery,
};

const sequenceStepSchemas = {
  click: input({
    ...elementTarget,
    ...framePoint,
    modifiers: {
      type: 'string',
      description: 'ctrl, shift, alt, win, or a +-joined combination.',
    },
    button: {
      type: 'string',
      enum: ['left', 'right', 'middle'],
    },
  }),
  type: input({
    ...elementTarget,
    ...framePoint,
    text: { type: 'string' },
  }, ['text']),
  key: input({
    ...elementTarget,
    keys: { type: 'string' },
  }, ['keys']),
  wait: input({
    duration: {
      type: 'number',
      minimum: 0,
      maximum: 30,
    },
  }, ['duration']),
};

const sequenceStep = {
  type: 'object',
  description: 'One focus-chain step. First: targeted click/type/key. Later: untargeted type/key/wait. Every nonfinal step must preserve the same target and focus.',
  properties: {
    action: { type: 'string', enum: ['click', 'type', 'key', 'wait'] },
    ...elementTarget,
    ...framePoint,
    text: { type: 'string' },
    keys: { type: 'string' },
    duration: { type: 'number', minimum: 0, maximum: 30 },
    modifiers: { type: 'string' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
  },
  required: ['action'],
  additionalProperties: false,
};

export const COMPUTER_INPUT_SCHEMA = {
  type: 'object',
  description: 'One high-level Computer Use action with only its action-specific fields.',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'Use list for targets, capture for state/pixels/search/zoom, window for window lifecycle, and clipboard for clipboard I/O.',
    },
    input: {
      type: 'object',
      description: 'Fields for the selected action.',
    },
    capture_after: captureAfter,
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
        type: 'string',
        description: 'Optional Windows OCR language tag to verify, e.g. ko or en-US.',
      },
    }), false),
    branch('capture', input(captureProperties), false),
    branch('click', input({
      ...pointerProperties,
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Left + ref uses semantic activate/toggle. Left + element/frame and right/middle use pointer input.',
      },
    })),
    branch('double_click', input(pointerProperties)),
    branch('mouse_move', input(pointerProperties)),
    branch('drag', input({
      ...windowTarget,
      ...appTarget,
      ...elementTarget,
      to: { type: 'string', description: 'Destination semantic ref.' },
      to_element: { type: 'integer', minimum: 1 },
      ...framePoint,
      to_x: { type: 'integer' },
      to_y: { type: 'integer' },
      modifiers: { type: 'string' },
      ...delivery,
    })),
    branch('type', input({
      ...windowTarget,
      ...appTarget,
      ...elementTarget,
      ...framePoint,
      text: { type: 'string' },
      mode: {
        type: 'string',
        enum: ['literal', 'set'],
        description: 'literal (default) types text; set writes the value into a ref target with no focus. Web inputs ignore set.',
      },
      ...delivery,
    }, ['text'])),
    branch('key', input({
      ...windowTarget,
      ...appTarget,
      ...elementTarget,
      keys: {
        type: 'string',
        description: 'SendKeys syntax, e.g. "^s", "%{F4}", or "Hello{ENTER}". Modifiers and groups require delivery="foreground".',
      },
      ...delivery,
    }, ['keys'])),
    branch('scroll', input({
      ...windowTarget,
      ...appTarget,
      ...elementTarget,
      ...framePoint,
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
      },
      amount: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
      },
      ...delivery,
    }, ['direction'])),
    branch('wait', input({
      duration: {
        type: 'number',
        minimum: 0,
        maximum: 30,
      },
    }, ['duration'])),
    branch('sequence', input({
      ...windowTarget,
      ...appTarget,
      steps: {
        type: 'array',
        items: sequenceStep,
        minItems: 2,
        maxItems: 6,
        description: 'Prefer this over separate calls for a deterministic same-window focus chain. A transition-capable step must be final; execution stops on failure or target transition.',
      },
      ...delivery,
    }, ['steps'])),
    branch('window', input({
      ...windowTarget,
      ...appTarget,
      operation: {
        type: 'string',
        enum: ['focus', 'move', 'minimize', 'maximize', 'restore', 'close'],
      },
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    }, ['operation'])),
    branch('menu', input({
      ...windowTarget,
      ...appTarget,
      path: {
        type: 'array',
        items: { type: 'string' },
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
            present: { type: 'string', description: 'Text an element name or value must contain.' },
            absent: { type: 'string' },
            title_contains: { type: 'string' },
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
      text: { type: 'string', description: 'Required for operation="write".' },
    }, ['operation'])),
    branch('launch', input({
      app: {
        type: 'string',
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

const CAPTURE_AFTER_ACTIONS = new Set([
  'click', 'double_click', 'mouse_move', 'drag', 'type', 'key', 'scroll',
  'sequence', 'window', 'menu', 'launch',
]);

// Actions that drive one exact window. They carry exactly one window target:
// the exact window_id, or an app label the host resolves to one window and
// refuses when it matches more than one.
const WINDOW_TARGET_ACTIONS = new Set([
  'click', 'double_click', 'mouse_move', 'drag', 'type', 'key', 'scroll',
  'sequence', 'window', 'menu', 'verify',
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function schemaValueError(value, schema, path) {
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(', ')}`;
  }
  if (schema.type === 'string' && typeof value !== 'string') return `${path} must be a string`;
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

function validateTargetForm(name, inputValue, { required = true } = {}) {
  const semantic = ['ref', 'element'].filter((key) => hasOwn(inputValue, key));
  const pointFields = ['frame_id', 'x', 'y'].filter((key) => hasOwn(inputValue, key));
  if (semantic.length > 1) return `${name} accepts only one of ref or element`;
  if (pointFields.length && pointFields.length !== 3) {
    return `${name} coordinate target requires frame_id, x, and y`;
  }
  const forms = semantic.length + (pointFields.length === 3 ? 1 : 0);
  if (forms > 1) return `${name} accepts only one target form`;
  if (required && forms === 0) return `${name} requires ref, element, or frame_id/x/y`;
  return null;
}

export function validateComputerToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Computer Use arguments must be an object';
  }
  const rootExtras = Object.keys(args).filter(
    (key) => !['action', 'input', 'capture_after'].includes(key),
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
  if (WINDOW_TARGET_ACTIONS.has(name)) {
    const windowTargets = ['window_id', 'app'].filter((key) => hasOwn(inputObject, key));
    if (windowTargets.length !== 1) {
      return `Computer Use ${name} requires exactly one of window_id or app`;
    }
    if (hasOwn(inputObject, 'app') && !String(inputObject.app || '').trim()) {
      return `Computer Use ${name} app must not be empty`;
    }
  }
  if (name === 'capture') {
    const mode = inputObject.mode || 'state';
    if (mode === 'zoom' && (!hasOwn(inputObject, 'frame_id') || !hasOwn(inputObject, 'region'))) {
      return 'Computer Use capture mode="zoom" requires input field(s): frame_id, region';
    }
    if (mode !== 'zoom' && (hasOwn(inputObject, 'frame_id') || hasOwn(inputObject, 'region'))) {
      return 'Computer Use capture frame_id/region requires mode="zoom"';
    }
    if (mode === 'ax' && inputObject.include_ocr === true) {
      return 'Computer Use capture include_ocr is unavailable with mode="ax"';
    }
    if (hasOwn(inputObject, 'screen') && mode !== 'vision') {
      return 'Computer Use capture screen requires mode="vision"';
    }
  }
  if (['click', 'double_click', 'mouse_move'].includes(name)) {
    const targetError = validateTargetForm(name, inputObject);
    if (targetError) return `Computer Use ${targetError}`;
  }
  if (name === 'type') {
    const targetError = validateTargetForm(name, inputObject, { required: false });
    if (targetError) return `Computer Use ${targetError}`;
    if (inputObject.mode === 'set' && !hasOwn(inputObject, 'ref')) {
      return 'Computer Use type mode="set" requires a semantic ref target';
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
    }
  }
  if (name === 'key') {
    const targetError = validateTargetForm(name, inputObject, { required: false });
    if (targetError) return `Computer Use ${targetError}`;
  }
  if (name === 'scroll') {
    const targetError = validateTargetForm(name, inputObject, { required: false });
    if (targetError) return `Computer Use ${targetError}`;
  }
  if (name === 'drag') {
    const semanticSource = ['ref', 'element'].filter((key) => hasOwn(inputObject, key));
    const semanticDestination = ['to', 'to_element'].filter((key) => hasOwn(inputObject, key));
    const pointFields = ['frame_id', 'x', 'y', 'to_x', 'to_y'].filter(
      (key) => hasOwn(inputObject, key),
    );
    const semantic = semanticSource.length === 1 && semanticDestination.length === 1;
    const coordinate = pointFields.length === 5;
    if (semanticSource.length > 1 || semanticDestination.length > 1 || (semantic && coordinate)) {
      return 'Computer Use drag accepts one matching semantic or coordinate target pair';
    }
    if (!semantic && !coordinate) {
      return 'Computer Use drag requires ref/element plus to/to_element, or frame_id/x/y/to_x/to_y';
    }
  }
  if (name === 'sequence') {
    const steps = inputObject.steps || [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        return `Computer Use sequence step ${index + 1} must be an object`;
      }
      const stepAction = String(step.action || '');
      const stepSchema = sequenceStepSchemas[stepAction];
      if (!stepSchema) {
        return `Computer Use sequence step ${index + 1} action must be one of: click, type, key, wait`;
      }
      const allowed = new Set(['action', ...Object.keys(stepSchema.properties)]);
      const extras = Object.keys(step).filter((key) => !allowed.has(key));
      if (extras.length) {
        return `Computer Use sequence step ${index + 1} does not accept field(s): ${extras.join(', ')}`;
      }
      const missing = (stepSchema.required || []).filter((key) => !hasOwn(step, key));
      if (missing.length) {
        return `Computer Use sequence step ${index + 1} requires field(s): ${missing.join(', ')}`;
      }
      const valueError = objectSchemaValueError(step, {
        properties: { action: { type: 'string', enum: [stepAction] }, ...stepSchema.properties },
      }, `Computer Use sequence step ${index + 1}`);
      if (valueError) return valueError;
      if (stepAction === 'click') {
        const targetError = validateTargetForm('sequence click', step);
        if (targetError) return `Computer Use ${targetError}`;
      } else if (stepAction === 'type' || stepAction === 'key') {
        const targetError = validateTargetForm(`sequence ${stepAction}`, step, { required: false });
        if (targetError) return `Computer Use ${targetError}`;
      }
      if (index === 0 && stepAction === 'wait') {
        return 'Computer Use sequence must start with click, type, or key';
      }
      if (index > 0) {
        if (!['type', 'key', 'wait'].includes(stepAction)) {
          return 'Computer Use sequence steps after the first must be type, key, or wait';
        }
        if (['ref', 'element', 'frame_id', 'x', 'y'].some((key) => hasOwn(step, key))) {
          return 'Computer Use sequence steps after the first reuse focus and cannot carry a target';
        }
      }
    }
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
  if (args.capture_after !== undefined) {
    if (!CAPTURE_AFTER_ACTIONS.has(name)) {
      return `Computer Use action "${name}" does not accept capture_after`;
    }
    if (!args.capture_after || typeof args.capture_after !== 'object'
      || Array.isArray(args.capture_after)) {
      return 'Computer Use capture_after must be an object';
    }
    const allowedAfter = new Set(Object.keys(captureAfter.properties));
    const afterExtras = Object.keys(args.capture_after).filter((key) => !allowedAfter.has(key));
    if (afterExtras.length) {
      return `Computer Use capture_after does not accept field(s): ${afterExtras.join(', ')}`;
    }
    const afterValueError = objectSchemaValueError(
      args.capture_after,
      captureAfter,
      'Computer Use capture_after',
    );
    if (afterValueError) return afterValueError;
  }
  return null;
}

export function toComputerHostCommand(args) {
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
    case 'click':
      command.action = inputValue.button === 'right'
        ? 'right_click'
        : inputValue.button === 'middle'
          ? 'middle_click'
          : inputValue.ref
            ? 'invoke'
            : 'click';
      delete command.button;
      break;
    case 'type':
      // A set writes the value straight into the element; literal keeps typing.
      command.action = inputValue.mode === 'set' ? 'set_value' : 'type';
      delete command.mode;
      break;
    case 'menu':
      command.action = 'invoke_menu';
      break;
    case 'sequence':
      command.action = 'sequence';
      command.steps = inputValue.steps.map((step) => {
        const translated = { ...step };
        if (step.action === 'click') {
          translated.action = step.button === 'right'
            ? 'right_click'
            : step.button === 'middle'
              ? 'middle_click'
              : step.ref
                ? 'invoke'
                : 'click';
          delete translated.button;
        }
        return translated;
      });
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
  if (args.capture_after) {
    command.capture_after = true;
    const afterFields = {
      delay_ms: 'capture_delay_ms',
      mode: 'capture_after_mode',
      max_elements: 'capture_after_max_elements',
      include_ocr: 'capture_after_include_ocr',
      ocr_language: 'capture_after_ocr_language',
      max_ocr_words: 'capture_after_max_ocr_words',
    };
    for (const [source, target] of Object.entries(afterFields)) {
      if (hasOwn(args.capture_after, source)) command[target] = args.capture_after[source];
    }
  }
  return command;
}

export const COMPUTER_ACTIONS = Object.freeze([...ACTIONS]);
