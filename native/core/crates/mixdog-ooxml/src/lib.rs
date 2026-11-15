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
