//! The bounds of the PDF analysis (`pdf/pdf-limits.mjs` and the defaults of `pdf-analysis.mjs` and `pdf-search.mjs`).

/// Pages one analysis call accepts. Shared with the model contract (the capability tables name it); rendering has no
/// page-count cap.
pub const MAX_PDF_ANALYSIS_PAGES: usize = 100;

/// Ruled lines, and boxes, kept from one page (`MAX_SHAPES_PER_PAGE`); links stop at the same count.
pub const MAX_SHAPES_PER_PAGE: usize = 2000;

/// Text items one layout call returns before it stops and reports `truncated` (`maxItems`).
pub const DEFAULT_MAX_ITEMS: usize = 20_000;

/// Bookmarks one outline call returns (`maxEntries`).
pub const DEFAULT_MAX_OUTLINE_ENTRIES: usize = 500;

/// Matches one text search returns (`limit`).
pub const DEFAULT_SEARCH_LIMIT: usize = 200;
