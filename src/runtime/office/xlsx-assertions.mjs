const ERROR_VALUE = /^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$/i;

function cellsFromDocument(document) {
  const cells = [];
  for (const sheet of document?.sheets || []) {
    for (const cell of sheet.cells || []) cells.push({ ...cell, sheet: sheet.name });
    for (const block of sheet.rowBlocks || []) {
      for (const row of block.rows || []) {
        for (const cell of row.cells || []) cells.push({ ...cell, sheet: sheet.name });
      }
    }
  }
  return cells;
}

function cellIndex(document) {
  return new Map(cellsFromDocument(document).map((cell) => [
    `${String(cell.sheet).toLowerCase()}!${String(cell.ref).toUpperCase()}`,
    cell,
  ]));
}

function reference(value, fallbackSheet = '') {
  if (typeof value === 'number') return { literal: value };
  if (value && typeof value === 'object' && value.cell) {
    return { sheet: String(value.sheet || fallbackSheet), cell: String(value.cell).toUpperCase() };
  }
  const match = /^(?:(?:'([^']+)'|([^!]+))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    sheet: String(match[1] || match[2] || fallbackSheet),
    cell: match[3].replaceAll('$', '').toUpperCase(),
  };
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameValue(actual, expected, tolerance = 0) {
  const left = numeric(actual);
  const right = numeric(expected);
  if (left !== null && right !== null) return Math.abs(left - right) <= Math.max(0, Number(tolerance) || 0);
  return String(actual ?? '') === String(expected ?? '');
}

function columnNumber(label) {
  let value = 0;
  for (const character of String(label).toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function parsedCell(value) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(String(value || '').replaceAll('$', ''));
  return match ? { column: columnNumber(match[1]), row: Number(match[2]) } : null;
}

function normalizeFormula(formula, origin) {
  const base = parsedCell(origin);
  return String(formula || '')
    .replace(/\s+/g, '')
    .replace(/(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/gi, (_all, absoluteColumn, label, absoluteRow, row) => {
      if (!base) return '#REF';
      const column = columnNumber(label);
      const rowNumber = Number(row);
      return `${absoluteRow ? `R${rowNumber}` : `R[${rowNumber - base.row}]`}${absoluteColumn ? `C${column}` : `C[${column - base.column}]`}`;
    })
    .toUpperCase();
}

function issue(assertion, index, code, message, path = '/') {
  return {
    severity: 'error',
    code,
    path,
    assertion: index + 1,
    message,
  };
}

export function evaluateXlsxAssertions(document, assertions = []) {
  const index = cellIndex(document);
  const issues = [];
  const results = [];
  const get = (value, fallbackSheet = '') => {
    const parsed = reference(value, fallbackSheet);
    if (!parsed) return null;
    if (parsed.literal !== undefined) return { value: parsed.literal, path: '' };
    return index.get(`${parsed.sheet.toLowerCase()}!${parsed.cell}`) || null;
  };
  assertions.forEach((assertion, assertionIndex) => {
    const kind = String(assertion?.kind || '').toLowerCase();
    const sheet = String(assertion?.sheet || document?.sheets?.[0]?.name || '');
    const target = assertion?.cell ? get({ sheet, cell: assertion.cell }) : null;
    let passed = true;
    if (kind === 'cell-value') {
      passed = Boolean(target) && sameValue(target.value, assertion.equals, assertion.tolerance);
      if (!passed) issues.push(issue(assertion, assertionIndex, 'assertion_value_mismatch', `Expected ${sheet}!${assertion.cell} to equal ${JSON.stringify(assertion.equals)}; actual value is ${JSON.stringify(target?.value ?? null)}.`, target?.path || `/sheet[${sheet}]/cell[${assertion.cell}]`));
    } else if (kind === 'cell-formula') {
      const actual = String(target?.formula || '');
      const comparableActual = actual.replace(/^=/, '');
      const comparableExpected = String(assertion.equals ?? '').replace(/^=/, '');
      passed = Boolean(target) && (assertion.equals !== undefined
        ? comparableActual === comparableExpected
        : new RegExp(String(assertion.matches || '')).test(actual));
      if (!passed) issues.push(issue(assertion, assertionIndex, 'assertion_formula_mismatch', `Formula assertion failed for ${sheet}!${assertion.cell}; actual formula is ${JSON.stringify(actual)}.`, target?.path || `/sheet[${sheet}]/cell[${assertion.cell}]`));
    } else if (kind === 'tie-out') {
      const left = get(assertion.left, sheet);
      const right = get(assertion.right, sheet);
      passed = Boolean(left && right) && sameValue(left.value, right.value, assertion.tolerance);
      if (!passed) issues.push(issue(assertion, assertionIndex, 'assertion_tie_out_failed', `Tie-out failed: ${JSON.stringify(assertion.left)}=${JSON.stringify(left?.value ?? null)} and ${JSON.stringify(assertion.right)}=${JSON.stringify(right?.value ?? null)}.`, left?.path || right?.path || '/'));
    } else if (kind === 'no-errors') {
      const failures = cellsFromDocument(document).filter((cell) => (
        (!assertion.sheet || String(cell.sheet).toLowerCase() === String(assertion.sheet).toLowerCase())
        && ERROR_VALUE.test(String(cell.value || ''))
      ));
      passed = failures.length === 0;
      for (const cell of failures.slice(0, 100)) issues.push(issue(assertion, assertionIndex, 'assertion_formula_error', `Formula error ${cell.value} violates no-errors assertion.`, cell.path));
    } else if (kind === 'formula-consistency') {
      const formulas = cellsFromDocument(document).filter((cell) => (
        cell.formula
        && (!assertion.sheet || String(cell.sheet).toLowerCase() === String(assertion.sheet).toLowerCase())
      ));
      const patterns = new Map();
      for (const cell of formulas) {
        const pattern = normalizeFormula(cell.formula, cell.ref);
        patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
      }
      const expected = [...patterns.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || '';
      const inconsistent = formulas.filter((cell) => normalizeFormula(cell.formula, cell.ref) !== expected);
      passed = formulas.length > 0 && inconsistent.length === 0;
      if (!formulas.length) issues.push(issue(assertion, assertionIndex, 'assertion_formula_missing', 'Formula-consistency assertion found no formulas.', `/sheet[${assertion.sheet || sheet}]`));
      for (const cell of inconsistent.slice(0, 100)) issues.push(issue(assertion, assertionIndex, 'assertion_formula_inconsistent', 'Formula differs from the dominant pattern in the asserted region.', cell.path));
    } else {
      passed = false;
      issues.push(issue(assertion, assertionIndex, 'assertion_kind_unknown', `Unknown XLSX assertion kind: ${kind || '(missing)'}`));
    }
    results.push({ index: assertionIndex + 1, kind, passed });
  });
  return {
    ok: issues.length === 0,
    checked: assertions.length,
    passed: results.filter((entry) => entry.passed).length,
    results,
    issues,
  };
}
