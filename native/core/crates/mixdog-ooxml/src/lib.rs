//! The portable OOXML engine: Office Open XML packages read, edited and written without Microsoft Office. Ported from
//! `src/runtime/office/portable/*.mjs`, which edits XML as strings and regular expressions rather than as a tree; the
//! port keeps that, with `mixdog_js::JsRegex` for every pattern, so a match is the one V8 finds. One crate holds all
//! the formats because their modules read each other (a docx part reads the docx snapshot, the snapshot helpers read the
//! pptx chart reader, and so on); later tasks add one module per Node file.
//!
//! This part: the XML string helpers ([`xml`]), the package container ([`zipio`]), content types and relationships
//! ([`opc`]), saving and creating packages ([`package`], [`blank`]), worksheet cells ([`cells`]), pptx shape
//! relationships ([`relations`]), the legacy-file check ([`legacy`]), template tokens ([`template_tokens`]), the
//! placeholder scan ([`placeholder_scan`]) and the document fingerprint ([`fingerprint`]).
//!
//! Offsets are byte offsets into the `&str` searched (Node's are UTF-16 units; the text between them is the same).

pub mod blank;
pub mod cells;
pub mod fingerprint;
pub mod legacy;
pub mod opc;
pub mod package;
pub mod placeholder_scan;
pub mod relations;
pub mod template_tokens;
pub mod xml;
pub mod zipio;
pub mod chart_faults;
pub mod docx_revisions;
pub mod validation_package;
pub mod image_layout;
pub mod pptx_chart;
pub mod pptx_core;
pub mod pptx_package;
pub mod pptx_targets;
pub mod review_editability;
pub mod slide_shapes;
pub mod snapshot_shared;
pub mod sheet_parts;
pub mod sheet_styles;
pub mod sheet_xml;
pub mod xlsx_cell_values;
pub mod text_metrics;
pub mod ooxml_validator;
pub mod chart;
pub mod shared_formulas;
pub mod sheet_page;
pub mod snapshot_docx;
pub mod pptx_deck;
pub mod pptx_table_fit;
pub mod snapshot_pptx;
pub mod pptx_shapes;
pub mod xlsx_audit_support;
pub mod xlsx_contract;
pub mod xlsx_conventions;
pub mod xlsx_sheet_hygiene;
pub mod xlsx_reference_shift;
pub mod pivot;
pub mod docx_parts;
pub mod docx_runs;
pub mod docx_formatting;
pub mod docx_styles;
pub mod docx_xml;
pub mod pptx;
pub mod pptx_charts;
pub mod xlsx_drawings;
pub mod snapshot_xlsx;
pub mod sheet_audits;
pub mod xlsx_range_layout;
pub mod xlsx_pivot_ops;
pub mod xlsx_formula_audit;
pub mod xlsx_assertions;
pub mod docx_tracked_edits;
pub mod docx_operations;
pub mod docx_edits;
pub mod docx;
pub mod validation;
pub mod snapshot;
pub mod soffice;
pub mod xlsx_charts;
pub mod portable;
pub mod xlsx;
pub mod xlsx_operations;
pub mod xlsx_recalculate;
pub mod xlsx_sheet_edits;
