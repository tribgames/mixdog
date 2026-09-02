import { plainObject } from '../shared/values.mjs';
import { issue } from './assurance-structure.mjs';

const CHECKLIST_RULES = Object.freeze({
  docx: [
    {
      id: 'heading-hierarchy',
      label: 'Heading hierarchy is present and does not skip levels.',
      codes: ['heading_hierarchy_missing', 'heading_hierarchy_jump'],
    },
    {
      id: 'orphan-headings',
      label: 'Headings stay with the content or table they introduce.',
      codes: ['orphan_heading', 'heading_table_separation'],
    },
    {
      id: 'table-integrity',
      label: 'Short tables are not split and fit inside page margins.',
      codes: ['short_table_split', 'table_width'],
    },
    {
      id: 'page-utilization',
      label: 'Rendered pages do not contain accidental blank or sparse pages.',
      codes: ['blank_page', 'sparse_page'],
    },
  ],
  xlsx: [
    {
      id: 'formula-integrity',
      label: 'Formula results, dependencies, and repeated formula regions are consistent.',
      prefixes: ['formula_', 'assertion_'],
    },
    {
      id: 'chart-scope',
      label: 'Charts contain valid series and exclude total or subtotal rows.',
      codes: ['empty_chart', 'broken_chart', 'chart_includes_total_row'],
    },
    {
      id: 'worksheet-hierarchy',
      label: 'Data sheets have a visible title, header, table, or styled hierarchy.',
      codes: ['worksheet_hierarchy_missing'],
    },
    {
      id: 'print-readability',
      label: 'Rendered worksheets use the page area at a readable scale.',
      codes: ['worksheet_print_too_small', 'worksheet_print_fit_missing'],
    },
  ],
  pptx: [
    {
      id: 'slide-geometry',
      label: 'Text and visual shapes respect margins, spacing, and non-overlap constraints.',
      codes: ['shape_overlap', 'text_outside_slide', 'edge_margin', 'text_spacing_tight'],
    },
    {
      id: 'slide-legibility',
      label: 'Text fits, meets minimum size, and has sufficient contrast.',
      codes: ['text_overflow', 'small_font', 'low_contrast'],
    },
    {
      id: 'visual-evidence',
      label: 'Content slides use subject-specific native evidence instead of generic repetition.',
      codes: [
        'meaningful_visual_missing',
        'native_evidence_too_weak',
        'repetitive_composition',
        'card_grid_overuse',
      ],
    },
    {
      id: 'source-provenance',
      label: 'Material numbers and claims cite a source in notes or provenance metadata.',
      codes: ['number_without_source'],
    },
  ],
  pdf: [
    {
      id: 'page-utilization',
      label: 'Rendered pages do not contain accidental blank or sparse pages.',
      codes: ['blank_page', 'sparse_page'],
    },
  ],
});

function issueMatches(item, entry) {
  if ((item.codes || []).includes(String(entry?.code || ''))) return true;
  return (item.prefixes || []).some((prefix) => String(entry?.code || '').startsWith(prefix));
}

function normalizedChecklistItem(value, index) {
  if (typeof value === 'string') {
    return {
      id: `task-${index + 1}`,
      label: value.trim(),
      required: true,
      manual: true,
    };
  }
  if (!plainObject(value)) return null;
  return {
    id: String(value.id || `task-${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-'),
    label: String(value.label || value.text || value.id || `Task check ${index + 1}`).trim(),
    required: value.required !== false,
    manual: true,
    ...(value.passed === true || value.status === 'pass' ? { passed: true } : {}),
    ...(value.passed === false || value.status === 'fail' ? { passed: false } : {}),
    ...(value.evidence ? { evidence: String(value.evidence) } : {}),
  };
}

export function evaluateOfficeChecklist({
  format,
  task = '',
  auditProfile = '',
  checklist = [],
  issues = [],
  visualCoverage = null,
} = {}) {
  const normalized = String(format || '').toLowerCase();
  const defaults = (CHECKLIST_RULES[normalized] || []).map((item) => {
    const matched = issues.filter((entry) => issueMatches(item, entry));
    return {
      id: item.id,
      label: item.label,
      required: true,
      status: matched.length ? 'fail' : 'pass',
      evidence: matched.map((entry) => entry.code),
    };
  });
  if (auditProfile === 'financial-model' && normalized === 'xlsx') {
    const matched = issues.filter((entry) => entry.code === 'missing_checks_sheet');
    defaults.push({
      id: 'checks-sheet',
      label: 'Financial model includes a Checks sheet with explicit tie-outs.',
      required: true,
      status: matched.length ? 'fail' : 'pass',
      evidence: matched.map((entry) => entry.code),
    });
  }
  const visualRequired = !['csv', 'tsv'].includes(normalized);
  if (visualRequired) {
    defaults.push({
      id: 'full-render-coverage',
      label: 'Every rendered page or slide was included in visual review.',
      required: true,
      status: visualCoverage?.complete === true ? 'pass' : 'fail',
      evidence: visualCoverage?.complete === true
        ? [`${visualCoverage.reviewed}/${visualCoverage.total}`]
        : ['visual coverage is incomplete'],
    });
  }
  const custom = (Array.isArray(checklist) ? checklist : [])
    .map(normalizedChecklistItem)
    .filter((entry) => entry?.label)
    .map((entry) => ({
      ...entry,
      status: entry.passed === true ? 'pass' : entry.passed === false ? 'fail' : 'pending',
      evidence: entry.evidence ? [entry.evidence] : [],
    }));
  const items = [...defaults, ...custom];
  const checklistIssues = custom
    .filter((entry) => entry.required && entry.status !== 'pass')
    .map((entry) => issue(
      entry.status === 'pending' ? 'checklist_item_pending' : 'checklist_item_failed',
      `/checklist/${entry.id}`,
      `Required task checklist item is ${entry.status}: ${entry.label}`,
      'checklist-review',
    ));
  const passed = items.filter((entry) => entry.status === 'pass').length;
  const failed = items.filter((entry) => entry.status === 'fail').length;
  const pending = items.filter((entry) => entry.status === 'pending').length;
  return {
    ok: failed === 0 && pending === 0,
    task: String(task || ''),
    auditProfile: String(auditProfile || ''),
    items,
    summary: {
      total: items.length,
      passed,
      failed,
      pending,
    },
    issues: checklistIssues,
  };
}
