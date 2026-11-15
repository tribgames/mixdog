//! What the office PDF writers draw with, from `src/runtime/office/pdf/pdf-draw.mjs`: the wrapping of text into lines
//! ([`wrap`]), and the page sizes, colours, rounding and image embedding (PNG, JPEG, SVG) of [`draw`].
//!
//! The choice of the font a document is written with (`pdf-fonts.mjs`) is [`crate::embed::embed_document_font`] and
//! [`crate::embed::embed_bold_font`], with the typographic stand-ins of [`crate::embed::Font::with_stand_ins`]; there is
//! one implementation of it, in the embedder.

pub mod draw;
pub mod wrap;
