const COMPUTER_CORE_ACTION_TYPES = Object.freeze([
  'click',
  'double_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'wait',
]);

export const COMPUTER_CORE_ACTION_SCHEMA = {
  type: 'object',
  description: 'One simple desktop action. Mixdog executes 1-6 actions in order and returns one fresh observation.',
  properties: {
    type: { type: 'string', enum: COMPUTER_CORE_ACTION_TYPES },
    ref: {
      type: 'string',
      minLength: 1,
      maxLength: 4_096,
      description: 'Fresh semantic ref from capture.',
    },
    element: { type: 'integer', minimum: 1, description: 'Fresh SOM/OCR mark from capture.' },
    x: { type: 'integer', description: 'Frame-relative X; act.input.frame_id owns the frame.' },
    y: { type: 'integer', description: 'Frame-relative Y; act.input.frame_id owns the frame.' },
    to: {
      type: 'string',
      minLength: 1,
      maxLength: 4_096,
      description: 'Drag destination semantic ref.',
    },
    to_element: { type: 'integer', minimum: 1 },
    to_x: { type: 'integer' },
    to_y: { type: 'integer' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    modifiers: {
      type: 'string',
      minLength: 1,
      maxLength: 32,
      pattern: '^(?:ctrl|shift|alt)(?:\\+(?:ctrl|shift|alt))*$',
      description: 'Optional pointer modifiers joined by +. Background supports ctrl/shift; alt requires foreground delivery.',
    },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'integer', minimum: 1, maximum: 100 },
    text: { type: 'string', maxLength: 30_000 },
    keys: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      pattern: '^[^\\u0000-\\u001F\\u007F-\\u009F]+$',
    },
    duration: { type: 'number', minimum: 0, maximum: 5 },
  },
  required: ['type'],
  additionalProperties: false,
};

const ALLOWED_FIELDS = new Set(Object.keys(COMPUTER_CORE_ACTION_SCHEMA.properties));
const TARGET_FIELDS = ['ref', 'element', 'x', 'y'];
const CONTINUATION_TARGET_FIELDS = [...TARGET_FIELDS, 'to', 'to_element', 'to_x', 'to_y'];
const FIELDS_BY_TYPE = {
  click: new Set(['type', ...TARGET_FIELDS, 'button', 'modifiers']),
  double_click: new Set(['type', ...TARGET_FIELDS, 'modifiers']),
  move: new Set(['type', ...TARGET_FIELDS, 'modifiers']),
  drag: new Set([
    'type', ...TARGET_FIELDS, 'to', 'to_element', 'to_x', 'to_y', 'modifiers',
  ]),
  scroll: new Set(['type', ...TARGET_FIELDS, 'direction', 'amount', 'modifiers']),
  type: new Set(['type', ...TARGET_FIELDS, 'text']),
  key: new Set(['type', 'ref', 'keys']),
  wait: new Set(['type', 'duration']),
};

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function targetFormError(action, { required = true, frameId = '' } = {}) {
  const semantic = ['ref', 'element'].filter((field) => hasOwn(action, field));
  const point = ['x', 'y'].filter((field) => hasOwn(action, field));
  if (semantic.length > 1) return 'accepts only one of ref or element';
  if (point.length && point.length !== 2) return 'coordinate target requires x and y';
  if (point.length === 2 && !frameId) return 'coordinate target requires act.input.frame_id';
  const forms = semantic.length + (point.length === 2 ? 1 : 0);
  if (forms > 1) return 'accepts only one semantic or coordinate target';
  if (required && forms === 0) return 'requires ref, element, or x/y';
  return null;
}

function finiteInteger(value) {
  return Number.isInteger(value);
}

function fieldValueError(field, value, label) {
  const schema = COMPUTER_CORE_ACTION_SCHEMA.properties[field];
  if (schema.enum && !schema.enum.includes(value)) {
    return `${label}.${field} must be one of: ${schema.enum.join(', ')}`;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${label}.${field} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${label}.${field} requires at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${label}.${field} accepts at most ${schema.maxLength} characters`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${label}.${field} must match the required format`;
    }
  }
  if (schema.type === 'integer' && !finiteInteger(value)) {
    return `${label}.${field} must be an integer`;
  }
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return `${label}.${field} must be a finite number`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${label}.${field} must be at least ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${label}.${field} must be at most ${schema.maximum}`;
    }
  }
  return null;
}

export function validateComputerCoreActions(
  actions,
  { frameId = '', delivery = 'background' } = {},
) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 6) {
    return 'Computer Use act actions must contain 1..6 items';
  }
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const label = `Computer Use act action ${index + 1}`;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      return `${label} must be an object`;
    }
    const type = String(action.type || '');
    if (!COMPUTER_CORE_ACTION_TYPES.includes(type)) {
      return `${label} has unknown type: ${type || '(empty)'}`;
    }
    const extras = Object.keys(action).filter((field) => !ALLOWED_FIELDS.has(field));
    if (extras.length) return `${label} does not accept field(s): ${extras.join(', ')}`;
    const typeExtras = Object.keys(action).filter((field) => !FIELDS_BY_TYPE[type].has(field));
    if (typeExtras.length) {
      return `${label} type="${type}" does not accept field(s): ${typeExtras.join(', ')}`;
    }
    for (const [field, value] of Object.entries(action)) {
      const valueError = fieldValueError(field, value, label);
      if (valueError) return valueError;
    }
    for (const field of ['ref', 'to']) {
      if (hasOwn(action, field) && !action[field].trim()) {
        return `${label}.${field} must not be empty`;
      }
    }
    if (typeof action.modifiers === 'string'
      && new Set(action.modifiers.split('+')).size !== action.modifiers.split('+').length) {
      return `${label}.modifiers must not repeat a modifier`;
    }
    if (typeof action.modifiers === 'string') {
      const modifierParts = action.modifiers.split('+');
      if (modifierParts.includes('alt') && delivery !== 'foreground') {
        return `${label}.modifiers alt requires act.input.delivery="foreground"`;
      }
    }
    if (index > 0) {
      if (!['type', 'key', 'wait'].includes(type)) {
        return 'Computer Use act actions after the first must be type, key, or wait';
      }
      const targeted = CONTINUATION_TARGET_FIELDS.filter((field) => hasOwn(action, field));
      if (targeted.length) {
        return 'Computer Use act actions after the first reuse focus and cannot carry a target';
      }
    } else if (type === 'wait') {
      return 'Computer Use act must start with an input action';
    }
    if (['click', 'double_click', 'move'].includes(type)) {
      const error = targetFormError(action, { frameId });
      if (error) return `${label} ${error}`;
    }
    if (type === 'drag') {
      const sourceSemantic = ['ref', 'element'].filter((field) => hasOwn(action, field));
      const destinationSemantic = ['to', 'to_element'].filter((field) => hasOwn(action, field));
      const sourcePoint = ['x', 'y'].filter((field) => hasOwn(action, field));
      const destinationPoint = ['to_x', 'to_y'].filter((field) => hasOwn(action, field));
      const semantic = sourceSemantic.length === 1 && destinationSemantic.length === 1;
      const coordinate = sourcePoint.length === 2 && destinationPoint.length === 2;
      if (sourceSemantic.length > 1 || destinationSemantic.length > 1
        || (semantic && coordinate) || (!semantic && !coordinate)) {
        return `${label} requires one matching semantic or coordinate source/destination pair`;
      }
      if (coordinate && !frameId) return `${label} coordinate target requires act.input.frame_id`;
    }
    if (type === 'scroll') {
      const error = targetFormError(action, { required: false, frameId });
      if (error) return `${label} ${error}`;
      if (!['up', 'down', 'left', 'right'].includes(action.direction)) {
        return `${label} direction must be up, down, left, or right`;
      }
    }
    if (type === 'type') {
      const error = targetFormError(action, { required: false, frameId });
      if (error) return `${label} ${error}`;
      if (typeof action.text !== 'string') return `${label} requires text`;
    }
    if (type === 'key') {
      if (typeof action.keys !== 'string') return `${label} requires keys`;
    }
    if (type === 'wait'
      && (typeof action.duration !== 'number' || !Number.isFinite(action.duration)
        || action.duration < 0 || action.duration > 5)) {
      return `${label} duration must be 0..5 seconds`;
    }
  }
  const totalWaitSeconds = actions.reduce(
    (total, action) => total + (action?.type === 'wait' ? Number(action.duration) || 0 : 0),
    0,
  );
  if (totalWaitSeconds > 10) {
    return 'Computer Use act wait actions accept at most 10 total seconds; use verify for longer conditions';
  }
  return null;
}
