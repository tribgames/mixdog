//! Feature tests of the PDF backend: a document written from blocks reads back as the text that went into it.

mod analysis;
mod content_ops;
mod forms;
mod links;
mod ocr;
mod pixels;
mod written;

// The suites that were binaries of their own; one binary is one link of the dependency graph instead of five.
#[path = "../ocr_engine.rs"]
mod ocr_engine;
#[path = "../preview_render.rs"]
mod preview_render;
#[path = "../render_text.rs"]
mod render_text;
#[path = "../security.rs"]
mod security;
