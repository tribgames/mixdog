import { color } from './pdf-draw.mjs';

export function fieldWidgets(field, document) {
  try {
    return field.acroField.getWidgets().map((widget) => {
      const rectangle = widget.getRectangle();
      const pageRef = widget.P();
      const page = document.getPages().findIndex((entry) => entry.ref === pageRef) + 1;
      return {
        page,
        x: Number(rectangle.x),
        y: Number(rectangle.y),
        width: Number(rectangle.width),
        height: Number(rectangle.height),
      };
    });
  } catch {
    return [];
  }
}

export function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function lintPdfFormFields(fields = [], pages = []) {
  const issues = [];
  const normalized = fields.map((field, index) => ({
    index: index + 1,
    name: String(field.name || ''),
    type: String(field.type || 'text').toLowerCase(),
    page: Math.max(1, Number(field.page) || 1),
    x: Number(field.x),
    y: Number(field.y),
    width: Number(field.width),
    height: Number(field.height),
  }));
  const names = new Set();
  for (const field of normalized) {
    const size = pages[field.page - 1] || [595.28, 841.89];
    if (!field.name) issues.push({ severity: 'error', code: 'missing_field_name', path: `/field[${field.index}]`, message: 'Form field name is required.' });
    if (names.has(field.name)) issues.push({ severity: 'error', code: 'duplicate_field_name', path: `/field[${field.index}]`, message: `Duplicate form field name: ${field.name}` });
    names.add(field.name);
    if (![field.x, field.y, field.width, field.height].every(Number.isFinite) || field.width <= 0 || field.height <= 0) {
      issues.push({ severity: 'error', code: 'invalid_field_box', path: `/field[${field.index}]`, message: 'Form field box must have finite positive dimensions.' });
    } else if (field.x < 0 || field.y < 0 || field.x + field.width > size[0] || field.y + field.height > size[1]) {
      issues.push({ severity: 'error', code: 'field_outside_page', path: `/field[${field.index}]`, message: `Form field is outside page ${field.page}.` });
    } else {
      // A box a person cannot hit or read: 8 pt squares for marks, 24 x 12 pt for anything typed.
      const mark = ['checkbox', 'radio'].includes(field.type);
      const [minWidth, minHeight] = mark ? [8, 8] : [24, 12];
      if (field.width < minWidth || field.height < minHeight) {
        issues.push({
          severity: 'warning',
          code: 'field_too_small',
          path: `/field[${field.index}]`,
          message: `Form field ${field.name || field.index} is ${field.width} x ${field.height} pt; a ${field.type} field needs at least ${minWidth} x ${minHeight}.`,
        });
      }
    }
  }
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (normalized[left].page === normalized[right].page && rectanglesOverlap(normalized[left], normalized[right])) {
        issues.push({
          severity: 'warning',
          code: 'overlapping_form_fields',
          path: `/field[${normalized[left].index}]`,
          message: `Form fields ${normalized[left].name || normalized[left].index} and ${normalized[right].name || normalized[right].index} overlap.`,
        });
      }
    }
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), fields: normalized, issueCount: issues.length, issues };
}

/**
 * Add one field. `font` is the face its appearance is drawn with: pdf-lib
 * paints a widget the moment it is added, so a dropdown or list whose
 * options are Korean needs the embedded face here, not only at save time.
 */
export async function addFormField(document, field, font = null) {
  const page = document.getPage(Math.max(1, Number(field.page) || 1) - 1);
  const form = document.getForm();
  const name = String(field.name);
  const options = {
    ...(font ? { font } : {}),
    x: Number(field.x),
    y: Number(field.y),
    width: Number(field.width),
    height: Number(field.height),
    borderWidth: Number(field.borderWidth ?? 1),
    textColor: color(field.textColor || '000000'),
    borderColor: color(field.borderColor || '666666'),
    backgroundColor: color(field.backgroundColor || 'FFFFFF'),
  };
  const type = String(field.type || 'text').toLowerCase();
  let control;
  if (type === 'checkbox') {
    control = form.createCheckBox(name);
    control.addToPage(page, options);
    if (checkboxOn(field.value)) control.check();
  } else if (type === 'dropdown') {
    control = form.createDropdown(name);
    control.addOptions((field.options || []).map(String));
    control.addToPage(page, options);
    if (field.editable) control.enableEditing();
    if (field.value != null) control.select(String(field.value));
  } else if (type === 'optionlist') {
    control = form.createOptionList(name);
    control.addOptions((field.options || []).map(String));
    control.addToPage(page, options);
    const values = field.value == null ? [] : choiceValues(field.value);
    if (field.multiselect || values.length > 1) control.enableMultiselect();
    if (values.length) control.select(values);
  } else if (type === 'radio') {
    control = form.createRadioGroup(name);
    for (const option of field.options || []) {
      control.addOptionToPage(String(option.value ?? option), page, {
        ...options,
        x: Number(option.x ?? field.x),
        y: Number(option.y ?? field.y),
      });
    }
    if (field.value != null) control.select(String(field.value));
  } else {
    control = form.createTextField(name);
    control.addToPage(page, options);
    if (field.multiline) control.enableMultiline();
    if (Number(field.maxLength) > 0) control.setMaxLength(Math.floor(Number(field.maxLength)));
    // pdf-lib's auto size fits a multiline value to the box height and drops
    // the lines that do not fit; a fixed body size keeps every line.
    if (Number(field.fontSize) > 0) control.setFontSize(Number(field.fontSize));
    else if (field.multiline) control.setFontSize(11);
    if (field.value != null) control.setText(String(field.value));
  }
  if (field.required) control.enableRequired();
  if (field.readOnly) control.enableReadOnly();
}

/** Every string a field carries, so the writer can pick a font that covers it. */
export function fieldText(field) {
  const options = Array.isArray(field?.options) ? field.options : [];
  return [String(field?.value ?? ''), ...options.map((option) => String(option?.value ?? option?.label ?? option ?? ''))].join(' ');
}

/** pdf-lib class name → the type vocabulary add_form_field and fill_form use. */
export function formFieldKind(field) {
  const type = field?.constructor?.name || '';
  if (type.includes('CheckBox')) return 'checkbox';
  if (type.includes('RadioGroup')) return 'radio';
  if (type.includes('Dropdown')) return 'dropdown';
  if (type.includes('OptionList')) return 'optionlist';
  if (type.includes('TextField')) return 'text';
  if (type.includes('Signature')) return 'signature';
  if (type.includes('Button')) return 'button';
  return 'unknown';
}

function fieldValue(field, kind = formFieldKind(field)) {
  try {
    if (kind === 'checkbox') return field.isChecked();
    if (kind === 'radio') return field.getSelected() ?? null;
    if (kind === 'dropdown') {
      const selected = field.getSelected();
      return field.isMultiselect() ? selected : (selected[0] ?? '');
    }
    if (kind === 'optionlist') return field.getSelected();
    if (kind === 'text') return field.getText() || '';
  } catch {}
  return null;
}

function fieldOptions(field, kind) {
  if (!['radio', 'dropdown', 'optionlist'].includes(kind)) return undefined;
  try {
    return field.getOptions();
  } catch {
    return [];
  }
}

export function describeFormField(field, document, index) {
  const kind = formFieldKind(field);
  const options = fieldOptions(field, kind);
  const flags = {};
  try {
    flags.readOnly = field.isReadOnly();
    flags.required = field.isRequired();
  } catch {}
  if (kind === 'checkbox') {
    try {
      const onValue = field.acroField.getOnValue()?.decodeText?.();
      if (onValue) flags.onValue = onValue;
    } catch {}
  }
  if (kind === 'text') {
    try {
      flags.multiline = field.isMultiline();
      const maxLength = field.getMaxLength();
      if (maxLength != null) flags.maxLength = maxLength;
    } catch {}
  }
  return {
    path: `/field[${index + 1}]`,
    index: index + 1,
    name: field.getName(),
    type: kind,
    value: fieldValue(field, kind),
    ...(options ? { options } : {}),
    ...flags,
    widgets: fieldWidgets(field, document),
  };
}

const CHECKBOX_OFF = new Set(['', 'false', '0', 'no', 'off', '/off', 'unchecked']);

function checkboxOn(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  if (typeof value === 'number') return value !== 0;
  return !CHECKBOX_OFF.has(String(value).trim().toLowerCase());
}

function choiceValues(value) {
  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry ?? '').replace(/^\//, ''));
}

/** Set every value by field name; an unknown name or option fails with what exists. Returns the names filled. */
export function fillFormValues(form, values) {
  const byName = new Map(form.getFields().map((field) => [field.getName(), field]));
  const entries = Object.entries(values || {});
  const missing = entries.map(([name]) => name).filter((name) => !byName.has(name));
  if (missing.length) {
    throw new Error(`PDF form has no field named ${missing.join(', ')}; fields: ${[...byName.keys()].join(', ') || '(none)'}`);
  }
  const filled = [];
  for (const [name, value] of entries) {
    const field = byName.get(name);
    const kind = formFieldKind(field);
    if (kind === 'checkbox') {
      if (checkboxOn(value)) field.check();
      else field.uncheck();
    } else if (kind === 'radio' || kind === 'dropdown' || kind === 'optionlist') {
      const options = field.getOptions();
      const wanted = choiceValues(value);
      const unknown = wanted.filter((entry) => !options.includes(entry));
      if (unknown.length && !(kind === 'dropdown' && field.isEditable())) {
        throw new Error(`Field ${name} has no option ${unknown.join(', ')}; options: ${options.join(', ') || '(none)'}`);
      }
      if (kind === 'radio') field.select(wanted[0]);
      else if (wanted.length > 1 || kind === 'optionlist') field.select(wanted);
      else field.select(wanted[0]);
    } else if (kind === 'text') {
      field.setText(value == null ? '' : String(value));
    } else {
      throw new Error(`Field ${name} is a ${kind} field and cannot be filled`);
    }
    filled.push(name);
  }
  return filled;
}
