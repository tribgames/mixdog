import { computerResultRecovery } from './error-recovery.mjs';

const ACT_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'pending', 'uncertain']);

function canonicalizeActResult(value, args) {
  value.completed_actions = value.completed_steps;
  value.total_actions = value.total_steps;
  const canonicalStep = (row, index) => {
    const normalized = { ...row };
    normalized.type = args.input?.actions?.[index]?.type || normalized.action;
    if (!ACT_STEP_STATUSES.has(normalized.status)) {
      normalized.status = normalized.ok === false ? 'failed' : 'succeeded';
    }
    delete normalized.action;
    delete normalized.ok;
    return normalized;
  };
  value.actions = Array.isArray(value.steps) ? value.steps.map(canonicalStep) : value.steps;
  // A single-window act reports the same transition on the act and its step.
  const transition = JSON.stringify(value.window_transition);
  for (const row of Array.isArray(value.actions) ? value.actions : []) {
    if (transition && JSON.stringify(row?.window_transition) === transition) delete row.window_transition;
  }
  delete value.completed_steps;
  delete value.total_steps;
  delete value.steps;
}

// Host diagnostics stay in the host's run record; the model acts on none of them.
const HOST_DIAGNOSTIC_FIELDS = ['timings_ms', 'capture_attempts'];

function dropHostDiagnostics(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) dropHostDiagnostics(item);
    return;
  }
  for (const field of HOST_DIAGNOSTIC_FIELDS) delete value[field];
  for (const item of Object.values(value)) dropHostDiagnostics(item);
}

// Elements and OCR text reach the model one line each, the shape browser
// snapshots use, because a field name costs more than the value it labels:
// `#mark [ref] Role "name" value="…" state=… source=… disabled focused
// @x,y,width,height actions`. Flags appear only when they differ from the
// common case the capture description states (an enabled UIA element), and
// the geometry a som frame repeats as x/y/width/height, center and
// screen_bounds collapses into its one bounds box.
const DERIVED_GEOMETRY_FIELDS = new Set([
  'x',
  'y',
  'width',
  'height',
  'center_x',
  'center_y',
  'center',
  'screen_bounds',
]);

const quotedText = (text) => JSON.stringify(String(text));
const bareText = (text) => (/^[^\s"]+$/.test(String(text)) ? String(text) : quotedText(text));
const isUnsetField = (field) =>
  field === undefined || field === null || field === '' || field === false || (Array.isArray(field) && !field.length);

function boundsText(box) {
  return box.length === 4 && box.every((edge) => Number.isFinite(edge)) ? `@${box.join(',')}` : null;
}

function extraFieldTexts(rest) {
  return Object.entries(rest)
    .filter(([key, field]) => !DERIVED_GEOMETRY_FIELDS.has(key) && !isUnsetField(field))
    .map(([key, field]) => `${key}=${typeof field === 'string' ? bareText(field) : JSON.stringify(field)}`);
}

function elementLine(element) {
  if (!element || typeof element !== 'object') return element;
  const { mark, ref, role, name, value, state, source, enabled, has_keyboard_focus, bounds, actions, ...rest } =
    element;
  return [
    isUnsetField(mark) ? null : `#${mark}`,
    isUnsetField(ref) ? null : `[${ref}]`,
    bareText(role || 'Unknown'),
    quotedText(name ?? ''),
    isUnsetField(value) ? null : `value=${quotedText(value)}`,
    isUnsetField(state) || state === source ? null : `state=${bareText(state)}`,
    isUnsetField(source) || source === 'uia' ? null : `source=${bareText(source)}`,
    enabled === false ? 'disabled' : null,
    has_keyboard_focus === true ? 'focused' : null,
    boundsText(Array.isArray(bounds) ? bounds : [rest.x, rest.y, rest.width, rest.height]),
    Array.isArray(actions) && actions.length ? actions.join(',') : null,
    ...extraFieldTexts(rest),
  ]
    .filter(Boolean)
    .join(' ');
}

function ocrTextLine(row) {
  if (!row || typeof row !== 'object') return row;
  const { mark, text, line, x, y, width, height, ...rest } = row;
  return [
    isUnsetField(mark) ? null : `#${mark}`,
    quotedText(text ?? ''),
    boundsText([x, y, width, height]),
    isUnsetField(line) ? null : `line=${line}`,
    ...extraFieldTexts(rest),
  ]
    .filter(Boolean)
    .join(' ');
}

function renderObservationLines(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (Array.isArray(frame.elements)) frame.elements = frame.elements.map(elementLine);
  for (const key of ['lines', 'words']) {
    if (Array.isArray(frame.ocr?.[key])) frame.ocr[key] = frame.ocr[key].map(ocrTextLine);
  }
}

export function canonicalComputerResultText(text, args) {
  if (args.action === 'clipboard' && args.input?.operation === 'read') return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') {
    return text;
  }
  value.action = args.action;
  if (args.action === 'list') value.kind = args.input?.kind;
  if (args.action === 'capture') value.mode = args.input?.mode || 'state';
  if (args.action === 'window') value.operation = args.input?.operation;
  if (args.action === 'clipboard') value.operation = args.input?.operation;
  if (args.action === 'act') canonicalizeActResult(value, args);
  if (value.capture_after && value.observation === undefined) {
    value.observation = value.capture_after;
    delete value.capture_after;
  }
  dropHostDiagnostics(value);
  renderObservationLines(value);
  renderObservationLines(value.observation);
  if (value.ok === false && value.recovery === undefined) {
    const recovery = computerResultRecovery(value, args);
    if (recovery) value.recovery = recovery;
  }
  return JSON.stringify(value);
}

// A capture payload reports the frame's real pixel size (`width`/`height`,
// nested under `observation` for action replies). Carrying it on the image
// block lets the context estimator bill a screenshot at its true vision cost
// instead of the flat unknown-image allowance. Provider normalizers rebuild
// the wire block from `type`/`source` alone, so these fields never reach an
// API and never shift the cached prefix.
export function computerImageDimensions(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  for (const frame of [value, value?.observation]) {
    const width = Number(frame?.width);
    const height = Number(frame?.height);
    if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  }
  return null;
}

export function canonicalComputerResultIsError(text, args) {
  if (args.action === 'clipboard' && args.input?.operation === 'read') return false;
  try {
    const value = JSON.parse(text);
    return Boolean(
      value && typeof value === 'object' && !Array.isArray(value) && value.action === args.action && value.ok === false
    );
  } catch {
    return false;
  }
}
