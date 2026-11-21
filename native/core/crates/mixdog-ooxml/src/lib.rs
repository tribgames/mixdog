//! The portable OOXML engine: Office Open XML packages read, edited and written without Microsoft Office. Ported from
//! `src/runtime/office/portable/*.mjs`, which edits XML as strings and regular expressions rather than as a tree; the
//! port keeps that, with `mixdog_js::JsRegex` for every pattern, so a match is the one V8 finds. One crate holds all
//! the formats because their modules read each other (a docx part reads the docx snapshot, the snapshot helpers read the
//! pptx chart reader, and so on).
//!
//! Offsets are byte offsets into the `&str` searched (Node's are UTF-16 units; the text between them is the same).

pub mod blank;
pub mod cells;
pub mod chart;
pub mod chart_faults;
pub mod docx;
pub mod docx_edits;
pub mod docx_formatting;
pub mod docx_operations;
pub mod docx_parts;
pub mod docx_revisions;
pub mod docx_runs;
pub mod docx_styles;
pub mod docx_tracked_edits;
pub mod docx_xml;
pub mod fingerprint;
pub mod image_layout;
pub mod legacy;
pub mod ooxml_validator;
pub mod opc;
pub mod package;
pub mod pivot;
pub mod placeholder_scan;
pub mod portable;
pub mod pptx;
pub mod pptx_chart;
pub mod pptx_charts;
pub mod pptx_core;
pub mod pptx_deck;
pub mod pptx_package;
pub mod pptx_shapes;
pub mod pptx_table_fit;
pub mod pptx_targets;
pub mod relations;
pub mod review_editability;
pub mod shared_formulas;
pub mod sheet_audits;
pub mod sheet_page;
pub mod sheet_parts;
pub mod sheet_styles;
pub mod sheet_xml;
pub mod slide_shapes;
pub mod snapshot;
pub mod snapshot_docx;
pub mod snapshot_pptx;
pub mod snapshot_shared;
pub mod snapshot_xlsx;
pub mod soffice;
pub mod template_tokens;
pub mod text_metrics;
pub mod validation;
pub mod validation_package;
pub mod xlsx;
pub mod xlsx_assertions;
pub mod xlsx_audit_support;
pub mod xlsx_cell_values;
pub mod xlsx_charts;
pub mod xlsx_contract;
pub mod xlsx_conventions;
pub mod xlsx_drawings;
pub mod xlsx_formula_audit;
pub mod xlsx_operations;
pub mod xlsx_pivot_ops;
pub mod xlsx_range_layout;
pub mod xlsx_recalculate;
pub mod xlsx_reference_shift;
pub mod xlsx_sheet_edits;
pub mod xlsx_sheet_hygiene;
pub mod xml;
pub mod zipio;
