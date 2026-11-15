//! The office PDF backend, ported from `src/runtime/office/pdf/pdf-document.mjs`, `pdf-analysis.mjs`, `pdf-search.mjs`
//! and `pdf-limits.mjs`. The reader is `mixdog-pdf` (pdf.js 6.4 in Rust): this crate opens a document with the office
//! options, lays a page's text out in top-left display coordinates together with the ruled lines, boxes and links it
//! paints, infers tables from that layout, extracts each painted image once as a PNG, flattens the outline and
//! searches the layout for a phrase.

pub mod analysis;
pub mod document;
pub mod limits;
pub mod search;
pub mod adapter;
pub mod edit_document;
pub mod safety;
pub mod security;
pub mod structure;
pub mod forms;
pub mod contact_sheets;
pub mod render;

pub use analysis::images::{ExtractedImage, ImageExtraction, ImageOptions, extract_pdf_images};
pub use analysis::layout::{
    BoxShape, LayoutItem, LayoutOptions, Link, PageLayout, PdfLayout, RuledLine,
    extract_pdf_text_layout,
};
pub use analysis::outline::{Outline, OutlineEntry, extract_pdf_outline};
pub use analysis::tables::{
    GeometryCell, GeometryRow, Merge, PdfTable, TableSet, TableSource, infer_pdf_tables,
};
pub use document::{AnalysisError, PdfSource, open_pdf, selected_pages};
pub use limits::MAX_PDF_ANALYSIS_PAGES;
pub use render::{RenderPagesOptions, RenderedImage, RenderedPages, render_pdf_pages};
pub use search::{Rect, SearchMatch, SearchOptions, SearchResult, find_pdf_text};
