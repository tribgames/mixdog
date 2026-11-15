//! What every part of the office engine shares: the value helpers, the format and id tables, the tool-result
//! envelope, the cell-reference parsers, the seam through which a writer reports the workspace file it is about to
//! write, the Office data directory, the transaction journal and the per-call write ledger that implements that seam.
//! Ported from `src/runtime/office/shared/*.mjs`, the head of `core/office-core.mjs`, `portable-cells.mjs` and
//! `xlsx-contract.mjs`; JavaScript string and number semantics are kept through `mixdog-js`.

pub mod a1;
pub mod asar_path;
pub mod bounded_read;
pub mod column_alignments;
pub mod column_widths;
pub mod data_dir;
pub mod envelope;
pub mod formats;
pub mod ids;
pub mod journal;
pub mod korean_particles;
pub mod labels;
pub mod ledger;
pub mod line_breaks;
pub mod page_sizes;
pub mod values;
pub mod write_note;

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod twin;
