mod read_codecs;
mod read_document;
mod read_encryption;
mod read_filters;
mod read_inspect;
mod read_jbig2;
mod read_jpx;
mod read_jpx_encode;
mod read_oplist;
mod read_support;
mod read_text;
mod render_images;
mod render_paint;
mod render_support;

// The suites that were binaries of their own; one binary is one link of the dependency graph instead of seven.
#[path = "../document_followup.rs"]
mod document_followup;
#[path = "../fontdraw_render.rs"]
mod fontdraw_render;
#[path = "../fontfile_cff_type1.rs"]
mod fontfile_cff_type1;
#[path = "../fontfile_cmap_truetype.rs"]
mod fontfile_cmap_truetype;
#[path = "../syntax.rs"]
mod syntax;
#[path = "../write_features.rs"]
mod write_features;
