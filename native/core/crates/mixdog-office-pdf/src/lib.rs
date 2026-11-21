//! The office PDF backend, ported from `src/runtime/office/pdf/pdf-document.mjs`, `pdf-analysis.mjs`, `pdf-search.mjs`
//! and `pdf-limits.mjs`. The reader is `mixdog-pdf` (pdf.js 6.4 in Rust).

pub mod adapter;
pub mod analysis;
pub mod batch;
pub mod contact_sheets;
pub mod content_ops;
pub mod document;
pub mod edit_document;
mod flatten;
pub mod forms;
pub mod limits;
pub mod marks;
pub mod ocr;
pub mod preview;
pub mod render;
pub mod safety;
pub mod search;
pub mod security;
pub mod structure;
pub mod writer;

pub use analysis::images::{ExtractedImage, ImageExtraction, ImageOptions, extract_pdf_images};
pub use analysis::layout::{BoxShape, LayoutItem, LayoutOptions, Link, PageLayout, PdfLayout, RuledLine, extract_pdf_text_layout};
pub use analysis::outline::{Outline, OutlineEntry, extract_pdf_outline};
pub use analysis::tables::{GeometryCell, GeometryRow, Merge, PdfTable, TableSet, TableSource, infer_pdf_tables};
pub use batch::{PdfFormView, apply_batch};
pub use content_ops::ContentOperations;
pub use document::{AnalysisError, PdfSource, open_pdf, selected_pages};
pub use limits::MAX_PDF_ANALYSIS_PAGES;
pub use marks::{MarkBox, Measure, display_point_to_user, display_to_user, report_boxes, target_boxes};
pub use ocr::{OcrContext, PageText, ocr_pdf, pdf_ocr_readiness, recognize_pdf_page_texts};
pub use render::{RenderPagesOptions, RenderedImage, RenderedPages, render_pdf_pages};
pub use search::{Rect, SearchMatch, SearchOptions, SearchResult, find_pdf_text};
